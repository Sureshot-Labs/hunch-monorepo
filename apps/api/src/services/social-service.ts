import { tx, type Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import { readDflowNativeAcceptingOrders } from "../lib/market-availability.js";
import { publicHunchAcceptingOrders } from "./hunch-market-availability.js";
import {
  DEFAULT_SOCIAL_POLICY,
  resolveSocialPolicy,
  SocialPolicyUnavailableError,
  type SocialPolicy,
} from "./social-policy.js";
import {
  readVerifiedBuy,
  requestVerifiedBuyRefresh,
  type VerifiedBuyFacts,
} from "./verified-buy.js";
import {
  compareSocialDecimal,
  decodeSocialCursor,
  divideSocialDecimal,
  encodeSocialCursor,
  normalizeSocialHandle,
  socialFingerprint,
  SocialError,
  socialPositionMetrics,
  socialText,
} from "./social-primitives.js";
import {
  SOCIAL_PUBLIC_AI,
  SOCIAL_PUBLIC_AUTHOR as publicAuthor,
  SOCIAL_NO_BLOCK as noBlock,
  SOCIAL_PUBLIC_THESIS as publicThesis,
  SOCIAL_VALID_ROOT_JOIN,
} from "./social-visibility.js";
import { buildSocialInstrument } from "./social-instrument.js";
import { verifiedBuyFactsSchema } from "../schemas/social-trade.js";

type Row = {
  id: string;
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  joined_at: string;
  is_following: boolean;
  is_blocked: boolean;
  follower_count: number;
  following_count: number;
  venue: string;
  status: string;
  close_time: Date | null;
  expiration_time: Date | null;
  event_end_time: Date | null;
  event_status: string | null;
  resolved_outcome: string | null;
  pm_accepting_orders: boolean | null;
  metadata: unknown;
  outcomes: unknown;
  current_token_id: string | null;
  event_id: string | null;
};
type PurchaseRef = { kind: "order" | "execution"; id: string };
type Target = { kind: "thesis" | "hunch"; id: string };
type Page = { cursor?: string; limit?: number };
export type SocialFeedInput = Page & {
  mode: "all" | "following";
  source: "all" | "thesis" | "hunch";
  authorId?: string;
  marketId?: string;
  eventId?: string;
};

const profileColumns = `u.id, u.handle, u.display_name, u.bio, coalesce(a.public_url,u.avatar_url) as avatar_url,
  u.created_at::text as joined_at,
  exists(select 1 from user_follows f where f.follower_user_id=$1::uuid and f.followed_user_id=u.id) as is_following,
  exists(select 1 from user_blocks b where b.blocker_user_id=$1::uuid and b.blocked_user_id=u.id) as is_blocked,
  (select count(*)::int from user_follows f where f.followed_user_id=u.id) as follower_count,
  (select count(*)::int from user_follows f where f.follower_user_id=u.id) as following_count`;

function profile(row: Row) {
  return {
    id: row.id,
    handle: row.handle ?? null,
    displayName: row.display_name?.trim() || row.handle || "Hunch trader",
    bio: row.bio ?? null,
    avatarUrl: row.avatar_url ?? null,
    joinedAt: row.joined_at,
    isFollowing: Boolean(row.is_following),
    isBlocked: Boolean(row.is_blocked),
    followerCount: row.follower_count ?? 0,
    followingCount: row.following_count ?? 0,
  };
}
function limitFor(
  requested: number | undefined,
  policy: { pageSize: number; maxPageSize: number },
): number {
  return Math.min(requested ?? policy.pageSize, policy.maxPageSize);
}
async function actor(db: DbQuery, userId: string, allowSuspended = false) {
  const { rows } = await db.query(
    `select id,social_suspended_at from users where id=$1 and is_active for update`,
    [userId],
  );
  if (!rows[0]) throw new SocialError("user_unavailable", 403);
  if (!allowSuspended && rows[0].social_suspended_at)
    throw new SocialError("social_suspended", 403);
}

async function readPagePolicy(db: DbQuery) {
  try {
    return (await resolveSocialPolicy(db)).policy;
  } catch (error) {
    if (!(error instanceof SocialPolicyUnavailableError)) throw error;
    // Only structural pagination falls back. Config never claims this is current.
    return {
      pageSize: DEFAULT_SOCIAL_POLICY.pageSize,
      maxPageSize: DEFAULT_SOCIAL_POLICY.maxPageSize,
    };
  }
}

async function market(
  db: DbQuery,
  marketId: string,
  lock = false,
): Promise<Row | null> {
  const { rows } = await db.query(
    `select m.*, e.status as event_status,e.end_date as event_end_time,pm.accepting_orders as pm_accepting_orders
    from unified_markets m left join unified_events e on e.id=m.event_id
    left join polymarket_markets pm on m.venue='polymarket' and pm.id=m.venue_market_id
    where m.id=$1 ${lock ? "for share of m" : ""}`,
    [marketId],
  );
  return rows[0] ?? null;
}
function accepting(row: Row | null): boolean {
  return (
    row !== null &&
    publicHunchAcceptingOrders({
      venue: row.venue,
      status: row.status,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
      eventEndTime: row.event_end_time,
      eventStatus: row.event_status,
      resolvedOutcome: row.resolved_outcome,
      pmAcceptingOrders: row.pm_accepting_orders,
      dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(row.metadata),
    })
  );
}
function outcomeLabel(row: Row, outcome: string) {
  try {
    const values =
      typeof row.outcomes === "string"
        ? JSON.parse(row.outcomes)
        : row.outcomes;
    return Array.isArray(values)
      ? (values[outcome === "NO" ? 1 : 0] ?? outcome)
      : outcome;
  } catch {
    return outcome;
  }
}

export class SocialService {
  constructor(
    private readonly db: Pool,
    private readonly checkWrite: (
      userId: string,
      policy: SocialPolicy,
      kind: "write" | "comment" | "report",
    ) => Promise<void> = async () => {},
    private readonly options: { limitlessPositionContract?: string } = {},
  ) {}

  private instrumentMatches(
    instrument: VerifiedBuyFacts["instrument"],
    row: Row,
  ): boolean {
    const current = buildSocialInstrument({
      marketId: instrument.marketId,
      venue: row.venue,
      outcome: instrument.outcome,
      tokenId: row.current_token_id ?? null,
      expiry: row.expiration_time
        ? new Date(row.expiration_time).toISOString()
        : null,
      metadata: row.metadata,
      limitlessPositionContract: this.options.limitlessPositionContract,
    });
    return (
      current !== null &&
      current.tokenId === instrument.tokenId &&
      current.generation === instrument.generation &&
      current.expiry === instrument.expiry
    );
  }

  private async purchaseMarket(
    db: DbQuery,
    facts: VerifiedBuyFacts,
    lock = false,
  ) {
    const selected = await market(db, facts.instrument.marketId, lock);
    if (!selected) return null;
    const token = await db.query(
      `select token_id from unified_tokens where token_id=$1 and market_id=$2 and side=$3`,
      [
        facts.instrument.tokenId,
        facts.instrument.marketId,
        facts.instrument.outcome,
      ],
    );
    selected.current_token_id = token.rows[0]?.token_id ?? null;
    return this.instrumentMatches(facts.instrument, selected) ? selected : null;
  }

  async getProfile(viewerId: string | null, userId: string) {
    const { rows } = await this.db.query(
      `select ${profileColumns} from users u left join content_assets a on a.id=u.avatar_asset_id and a.status='ready'
      where u.id=$2 and ${publicAuthor} and ${noBlock}`,
      [viewerId, userId],
    );
    if (!rows[0]) throw new SocialError("profile_not_found", 404);
    let statistics: Awaited<
      ReturnType<SocialService["profileStatistics"]>
    > | null;
    try {
      statistics = await this.profileStatistics(userId);
    } catch (error) {
      if (!(error instanceof SocialPolicyUnavailableError)) throw error;
      statistics = null;
    }
    return { profile: profile(rows[0]), statistics };
  }

  async profileByHandle(viewerId: string | null, handle: string) {
    const { rows } = await this.db.query(
      `select id from users where handle=lower($1) and is_active and social_suspended_at is null`,
      [handle.trim()],
    );
    if (!rows[0]) throw new SocialError("profile_not_found", 404);
    return this.getProfile(viewerId, rows[0].id);
  }

  async handleAvailability(userId: string | null, raw: string) {
    const { policy } = await resolveSocialPolicy(this.db);
    const handle = normalizeSocialHandle(
      raw,
      policy.handleMinLength,
      policy.handleMaxLength,
    );
    const { rows } = await this.db.query(
      `select id from users where handle=$1`,
      [handle],
    );
    return { handle, available: !rows[0] || rows[0].id === userId };
  }

  async updateProfile(
    userId: string,
    input: {
      handle?: string;
      displayName?: string;
      bio?: string;
      avatarAssetId?: string | null;
    },
  ) {
    const { policy } = await resolveSocialPolicy(this.db);
    if (!policy.enabled) throw new SocialError("social_disabled", 503);
    await this.checkWrite(userId, policy, "write");
    const handle =
      input.handle === undefined
        ? undefined
        : normalizeSocialHandle(
            input.handle,
            policy.handleMinLength,
            policy.handleMaxLength,
          );
    const displayName =
      input.displayName === undefined
        ? undefined
        : socialText(input.displayName, policy.displayNameMaxGraphemes);
    const bio =
      input.bio === undefined
        ? undefined
        : socialText(input.bio, policy.bioMaxGraphemes, true);
    try {
      await tx(this.db, async (db) => {
        await actor(db, userId);
        let avatarUrl: string | null = null;
        if (input.avatarAssetId) {
          const assets = await db.query(
            `select public_url from content_assets where id=$1 and owner_user_id=$2 and kind='image' and status='ready' for update`,
            [input.avatarAssetId, userId],
          );
          if (!assets.rows[0]) throw new SocialError("avatar_unavailable", 409);
          avatarUrl = assets.rows[0].public_url;
        }
        const { rows } = await db.query(
          `select handle,handle_changed_at from users where id=$1`,
          [userId],
        );
        if (
          handle !== undefined &&
          handle !== rows[0].handle &&
          rows[0].handle_changed_at &&
          Date.now() - new Date(rows[0].handle_changed_at).getTime() <
            policy.handleCooldownSeconds * 1000
        )
          throw new SocialError("handle_cooldown", 409);
        await db.query(
          `update users set
          handle=case when $2::boolean then $3 else handle end,
          handle_changed_at=case when $2::boolean and handle is distinct from $3 then now() else handle_changed_at end,
          display_name=case when $4::boolean then $5 else display_name end,
          bio=case when $6::boolean then $7 else bio end,
          avatar_asset_id=case when $8::boolean then $9::uuid else avatar_asset_id end,
          avatar_url=case when $8::boolean then $10 else avatar_url end,
          profile_name_edited_at=case when $4::boolean then now() else profile_name_edited_at end,
          profile_avatar_edited_at=case when $8::boolean then now() else profile_avatar_edited_at end,
          updated_at=now() where id=$1`,
          [
            userId,
            handle !== undefined,
            handle ?? null,
            displayName !== undefined,
            displayName ?? null,
            bio !== undefined,
            bio ?? null,
            input.avatarAssetId !== undefined,
            input.avatarAssetId ?? null,
            avatarUrl,
          ],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new SocialError("handle_taken", 409);
      throw error;
    }
    return this.getProfile(userId, userId);
  }

  async profileStatistics(userId: string) {
    const { policy } = await resolveSocialPolicy(this.db);
    const { rows } = await this.db.query(
      `with thesis_groups as (
      select t.market_id,t.outcome,t.instrument_generation,t.token_id,t.expiry,bool_or(t.proof_invalidated_at is null) as valid
      from user_theses t where t.author_id=$1 and ($2::int is null or t.published_at>=now()-($2::int*interval '1 day'))
      group by t.market_id,t.outcome,t.instrument_generation,t.token_id,t.expiry
    ) select g.*,m.venue,m.metadata,m.expiration_time,m.resolved_outcome,m.resolved_outcome_pct::text,m.event_id,m.category,current_token.token_id as current_token_id
      from thesis_groups g left join unified_markets m on m.id=g.market_id
      left join unified_tokens current_token on current_token.token_id=g.token_id and current_token.market_id=g.market_id and current_token.side=g.outcome`,
      [userId, policy.profileStatsWindowDays],
    );
    let wins = 0,
      losses = 0,
      fractional = 0,
      voided = 0,
      pending = 0,
      invalidated = 0;
    const events = new Set<string>();
    const categories = new Map<string, number>();
    for (const row of rows) {
      if (!row.valid) {
        invalidated++;
        continue;
      }
      if (row.event_id) events.add(row.event_id);
      if (row.category)
        categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
      const matching = this.instrumentMatches(
        {
          marketId: row.market_id,
          venue: row.venue,
          tokenId: row.token_id,
          outcome: row.outcome,
          generation: row.instrument_generation,
          expiry: row.expiry ? new Date(row.expiry).toISOString() : null,
        },
        row,
      );
      const result = socialPositionMetrics({
        notional: "1",
        grossShares: "1",
        netShares: "1",
        outcome: row.outcome,
        resolvedOutcome: matching ? row.resolved_outcome : null,
        resolvedOutcomePct: matching ? row.resolved_outcome_pct : null,
        active: false,
        mark: null,
      });
      if (result.state === "win") wins++;
      else if (result.state === "loss") losses++;
      else if (result.state === "fractional") fractional++;
      else if (result.state === "void") voided++;
      else pending++;
    }
    return {
      wins,
      losses,
      fractional,
      void: voided,
      pending,
      totalGroups: rows.length,
      invalidated,
      eventCount: events.size,
      winRate:
        wins + losses >= policy.profileStatsMinResolved
          ? divideSocialDecimal(String(wins), String(wins + losses))
          : null,
      primaryCategory:
        [...categories].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]?.[0] ?? null,
      badges: null,
      basis: "published_theses" as const,
    };
  }

  async setFollow(userId: string, targetId: string, follow: boolean) {
    if (userId === targetId) throw new SocialError("self_follow", 400);
    await tx(this.db, async (db) => {
      // Lock both users in UUID order, shared with block, to serialize conflicting edges.
      await db.query(
        `select id from users where id=any($1::uuid[]) order by id for update`,
        [[userId, targetId]],
      );
      await actor(db, userId, !follow);
      if (!follow) {
        await db.query(
          `delete from user_follows where follower_user_id=$1 and followed_user_id=$2`,
          [userId, targetId],
        );
        return;
      }
      const existing = await db.query(
        `select 1 from user_follows where follower_user_id=$1 and followed_user_id=$2`,
        [userId, targetId],
      );
      if (existing.rows.length) return;
      const { policy } = await resolveSocialPolicy(db);
      if (!policy.enabled) throw new SocialError("social_disabled", 503);
      await this.checkWrite(userId, policy, "write");
      const target = await db.query(
        `select u.id from users u where u.id=$2 and ${publicAuthor} and ${noBlock}`,
        [userId, targetId],
      );
      if (!target.rows[0]) throw new SocialError("profile_not_found", 404);
      await db.query(
        `insert into user_follows(follower_user_id,followed_user_id) values($1,$2) on conflict do nothing`,
        [userId, targetId],
      );
    });
    return { ok: true as const };
  }

  async setBlock(userId: string, targetId: string, blocked: boolean) {
    if (userId === targetId) throw new SocialError("self_block", 400);
    await tx(this.db, async (db) => {
      await db.query(
        `select id from users where id=any($1::uuid[]) order by id for update`,
        [[userId, targetId]],
      );
      await actor(db, userId, true);
      if (!blocked) {
        await db.query(
          `delete from user_blocks where blocker_user_id=$1 and blocked_user_id=$2`,
          [userId, targetId],
        );
        return;
      }
      const exists = await db.query(
        `select id from users where id=$1 and is_active`,
        [targetId],
      );
      if (!exists.rows[0]) throw new SocialError("profile_not_found", 404);
      await db.query(
        `insert into user_blocks(blocker_user_id,blocked_user_id) values($1,$2) on conflict do nothing`,
        [userId, targetId],
      );
      await db.query(
        `delete from user_follows where (follower_user_id=$1 and followed_user_id=$2) or (follower_user_id=$2 and followed_user_id=$1)`,
        [userId, targetId],
      );
    });
    return { ok: true as const };
  }

  async listProfiles(
    viewerId: string | null,
    input: Page & {
      kind: "followers" | "following" | "blocked" | "suggestions";
      userId?: string;
    },
  ) {
    const policy = await readPagePolicy(this.db);
    const limit = limitFor(input.limit, policy);
    const scope = socialFingerprint([
      "profiles",
      viewerId,
      input.kind,
      input.userId ?? null,
    ]);
    const cursor = decodeSocialCursor(input.cursor, scope);
    if (input.kind === "blocked" && !viewerId)
      throw new SocialError("unauthorized", 401);
    if (input.kind === "followers" || input.kind === "following") {
      const visible = await this.db.query(
        `select u.id from users u where u.id=$2 and ${publicAuthor} and ${noBlock}`,
        [viewerId, input.userId ?? viewerId],
      );
      if (!visible.rows.length) throw new SocialError("profile_not_found", 404);
    }
    let selected: string;
    const values: unknown[] = [
      viewerId,
      input.userId ?? viewerId,
      cursor?.timestamp ?? null,
      cursor?.id ?? null,
      limit + 1,
    ];
    if (input.kind === "suggestions")
      selected = `select u.id,latest.published_at as sort_at from users u
      cross join lateral (select t.published_at from user_theses t where t.author_id=u.id
        and t.author_hidden_at is null and t.moderation_hidden_at is null and t.proof_invalidated_at is null
        order by t.published_at desc,t.id desc limit 1) latest
      where ${publicAuthor} and ${noBlock} and u.id is distinct from $1::uuid and not exists(select 1 from user_follows f where f.follower_user_id=$1::uuid and f.followed_user_id=u.id)`;
    else if (input.kind === "blocked")
      selected = `select u.id,b.created_at as sort_at from user_blocks b join users u on u.id=b.blocked_user_id where b.blocker_user_id=$1::uuid`;
    else
      selected = `select u.id,f.created_at as sort_at from user_follows f join users u on u.id=f.${input.kind === "followers" ? "follower_user_id" : "followed_user_id"}
      where f.${input.kind === "followers" ? "followed_user_id" : "follower_user_id"}=$2::uuid and ${publicAuthor} and ${noBlock}`;
    const { rows } = await this.db.query(
      `with candidates as (${selected}), selected as (
      select * from candidates where ($3::timestamptz is null or (sort_at,id)<($3::timestamptz,$4::uuid)) order by sort_at desc,id desc limit $5
    ) select ${profileColumns},$2::uuid as subject_id,s.sort_at::text as sort_at from selected s join users u on u.id=s.id left join content_assets a on a.id=u.avatar_asset_id and a.status='ready' order by s.sort_at desc,u.id desc`,
      values,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(profile),
      nextCursor:
        rows.length > limit && last
          ? encodeSocialCursor({
              scope,
              timestamp: last.sort_at,
              kind: "user",
              id: last.id,
            })
          : null,
    };
  }

  async eligibility(userId: string, purchaseRef: PurchaseRef) {
    const resolved = await resolveSocialPolicy(this.db);
    const result = await readVerifiedBuy(this.db, { userId, purchaseRef });
    const facts = result.facts;
    let existingThesisId: string | null = null;
    if (facts) {
      const existing = await this.db.query(
        `select id from user_theses where canonical_purchase_key=$1 and author_id=$2`,
        [facts.canonicalPurchaseKey, userId],
      );
      existingThesisId = existing.rows[0]?.id ?? null;
    }
    let reason: string | null = null;
    if (existingThesisId) reason = "already_published";
    else if (result.state !== "verified" || !facts)
      reason = result.reason ?? result.state;
    else if (!resolved.policy.enabled || !resolved.policy.publicationsEnabled)
      reason = "publications_disabled";
    else if (
      compareSocialDecimal(
        facts.grossNotionalUsd,
        resolved.policy.minimumNotionalUsd,
      ) < 0
    )
      reason = "below_minimum";
    else if (!accepting(await this.purchaseMarket(this.db, facts)))
      reason = "market_closed_or_instrument_changed";
    return {
      eligible: reason === null,
      reason,
      state: result.state,
      minimumNotionalUsd: resolved.policy.minimumNotionalUsd,
      grossNotionalUsd: facts?.grossNotionalUsd ?? null,
      existingThesisId,
      policyRevision: resolved.revision,
    };
  }

  async refreshEligibility(userId: string, purchaseRef: PurchaseRef) {
    const { policy } = await resolveSocialPolicy(this.db);
    await this.checkWrite(userId, policy, "write");
    if (!(await requestVerifiedBuyRefresh(this.db, { userId, purchaseRef })))
      throw new SocialError("purchase_not_found", 404);
    return { ok: true as const };
  }

  async publish(
    userId: string,
    input: { purchaseRef: PurchaseRef; body: string; idempotencyKey: string },
  ) {
    const payloadHash = socialFingerprint({
      purchaseRef: input.purchaseRef,
      body: input.body.normalize("NFC").trim(),
    });
    const thesisId = await tx(this.db, async (db) => {
      await actor(db, userId, true);
      const prior = await db.query(
        `select id,payload_hash from user_theses where author_id=$1 and idempotency_key=$2`,
        [userId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== payloadHash)
          throw new SocialError("idempotency_conflict", 409);
        return prior.rows[0].id as string;
      }
      await actor(db, userId);
      const { policy, revision } = await resolveSocialPolicy(db);
      if (!policy.enabled || !policy.publicationsEnabled)
        throw new SocialError("publications_disabled", 503);
      await this.checkWrite(userId, policy, "write");
      const body = socialText(input.body, policy.thesisMaxGraphemes);
      const buy = await readVerifiedBuy(db, {
        userId,
        purchaseRef: input.purchaseRef,
        lock: true,
      });
      if (buy.state !== "verified" || !buy.facts)
        throw new SocialError(buy.reason ?? "buy_not_verified", 409);
      const facts = buy.facts;
      const existing = await db.query(
        `select id from user_theses where canonical_purchase_key=$1`,
        [facts.canonicalPurchaseKey],
      );
      if (existing.rows[0])
        throw new SocialError("purchase_already_published", 409);
      if (
        compareSocialDecimal(
          facts.grossNotionalUsd,
          policy.minimumNotionalUsd,
        ) < 0
      )
        throw new SocialError("below_minimum", 409);
      const selectedMarket = await this.purchaseMarket(db, facts, true);
      if (!selectedMarket || !accepting(selectedMarket))
        throw new SocialError("market_closed_or_instrument_changed", 409);
      const created = await db.query(
        `insert into user_theses(author_id,canonical_purchase_key,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash,order_id,execution_id,expiry)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::numeric,$12,$13,$14,$15,$16) returning id`,
        [
          userId,
          facts.canonicalPurchaseKey,
          facts.instrument.marketId,
          selectedMarket.event_id,
          facts.instrument.tokenId,
          facts.instrument.outcome,
          facts.instrument.generation,
          body,
          JSON.stringify(facts),
          revision,
          facts.grossNotionalUsd,
          input.idempotencyKey,
          payloadHash,
          input.purchaseRef.kind === "order" ? input.purchaseRef.id : null,
          input.purchaseRef.kind === "execution" ? input.purchaseRef.id : null,
          facts.instrument.expiry,
        ],
      );
      return created.rows[0].id as string;
    });
    return this.getThesis(userId, thesisId, true);
  }

  async hideThesis(userId: string, id: string) {
    const result = await this.db.query(
      `update user_theses set author_hidden_at=coalesce(author_hidden_at,now()) where id=$1 and author_id=$2 returning id`,
      [id, userId],
    );
    if (!result.rows[0]) throw new SocialError("thesis_not_found", 404);
    return { ok: true as const };
  }

  async getThesis(
    viewerId: string | null,
    id: string,
    includeOwnHidden = false,
  ) {
    const items = await this.loadTheses(viewerId, [id], includeOwnHidden);
    if (!items[0]) throw new SocialError("thesis_not_found", 404);
    return items[0];
  }

  async loadTheses(
    viewerId: string | null,
    ids: string[],
    includeOwnHidden = false,
  ) {
    if (!ids.length) return [];
    let policy: SocialPolicy | null = null;
    try {
      policy = (await resolveSocialPolicy(this.db)).policy;
    } catch (error) {
      if (!(error instanceof SocialPolicyUnavailableError)) throw error;
    }
    const { rows } = await this.db.query(
      `select t.*,t.id as thesis_id,t.published_at::text as published_at,${profileColumns},
      m.title,m.outcomes,coalesce(m.image,e.image) as image,m.status,m.venue,m.resolved_outcome,m.resolved_outcome_pct::text,m.close_time,m.expiration_time,m.metadata,
      e.status as event_status,e.end_date as event_end_time,pm.accepting_orders as pm_accepting_orders,
      current_token.token_id as current_token_id,
      case when q.ts<=now() and q.ts>=now()-($4::int*interval '1 second') then coalesce(q.mid,(q.best_bid+q.best_ask)/2)::text end as mark,
      (select count(*)::int from social_comments c join users cu on cu.id=c.author_id where c.thesis_id=t.id and c.author_hidden_at is null and c.moderation_hidden_at is null and cu.is_active and cu.social_suspended_at is null
        and not exists(select 1 from user_blocks b where (b.blocker_user_id=$1::uuid and b.blocked_user_id=cu.id) or (b.blocked_user_id=$1::uuid and b.blocker_user_id=cu.id))) as comment_count,
      (select count(distinct ca.copier_user_id)::int from copy_attributions ca where ca.source_thesis_id=t.id and ca.state='confirmed' and ca.copier_user_id is distinct from t.author_id) as copy_count
      from user_theses t join users u on u.id=t.author_id left join content_assets a on a.id=u.avatar_asset_id and a.status='ready'
      left join unified_markets m on m.id=t.market_id left join unified_events e on e.id=m.event_id
      left join polymarket_markets pm on m.venue='polymarket' and pm.id=m.venue_market_id
      left join unified_tokens current_token on current_token.token_id=t.token_id and current_token.market_id=t.market_id and current_token.side=t.outcome
      left join unified_token_top_latest q on q.token_id=t.token_id
      where t.id=any($2::uuid[]) and ((${publicThesis}) or ($3 and t.author_id=$1::uuid))`,
      [viewerId, ids, includeOwnHidden, policy?.markMaxAgeSeconds ?? null],
    );
    return rows.map((row) => {
      const facts = row.buy_snapshot as VerifiedBuyFacts;
      const matching = this.instrumentMatches(facts.instrument, row);
      const canTrade = matching && accepting(row);
      const visibility = row.proof_invalidated_at
        ? ("invalidated" as const)
        : row.moderation_hidden_at
          ? ("moderation_hidden" as const)
          : row.author_hidden_at
            ? ("author_hidden" as const)
            : ("public" as const);
      return {
        kind: "thesis" as const,
        id: row.thesis_id,
        author: profile(row),
        body: row.body,
        publishedAt: row.published_at,
        purchasedAt: facts.purchasedAt,
        instrument: {
          ...facts.instrument,
          eventId: row.event_id,
          title: row.title ?? null,
          outcomeLabel: outcomeLabel(row, facts.instrument.outcome),
          image: row.image ?? null,
        },
        grossNotionalUsd: facts.grossNotionalUsd,
        netShares: facts.netShares,
        position: socialPositionMetrics({
          notional: facts.grossNotionalUsd,
          grossShares: facts.grossShares,
          netShares: facts.netShares,
          outcome: facts.instrument.outcome,
          resolvedOutcome: matching ? row.resolved_outcome : null,
          resolvedOutcomePct: matching ? row.resolved_outcome_pct : null,
          active: canTrade,
          mark: row.mark,
        }),
        commentCount: row.comment_count,
        copyCount: row.copy_count,
        canCopy:
          Boolean(policy?.enabled && policy.copyEnabled) &&
          canTrade &&
          visibility === "public" &&
          viewerId !== row.author_id,
        visibility,
      };
    });
  }

  async feed(viewerId: string | null, input: SocialFeedInput) {
    if (input.mode === "following" && !viewerId)
      throw new SocialError("unauthorized", 401);
    const policy = await readPagePolicy(this.db);
    const limit = limitFor(input.limit, policy);
    const scope = socialFingerprint([
      "feed",
      viewerId,
      input.mode,
      input.source,
      input.authorId ?? null,
      input.marketId ?? null,
      input.eventId ?? null,
    ]);
    const cursor = decodeSocialCursor(input.cursor, scope);
    const values = [
      viewerId,
      input.marketId ?? null,
      input.eventId ?? null,
      input.authorId ?? null,
      cursor?.timestamp ?? null,
      cursor?.kind ?? null,
      cursor?.id ?? null,
      limit + 1,
    ];
    // Separate query shapes keep generic plans selective; nullable-OR filters can scan an entire empty market tail.
    const thesisFilters = `${input.marketId ? "and t.market_id=$2::text" : ""} ${input.eventId ? "and t.event_id=$3::text" : ""} ${input.authorId ? "and t.author_id=$4::uuid" : ""}
      ${cursor ? "and (t.published_at,'thesis'::text,t.id)<($5::timestamptz,$6::text,$7::uuid)" : ""}`;
    // ANY(single scope) retains the leading market/event ordering key in generic plans.
    // With plain equality PG can discard that key and scan the global time index for a sparse/empty scope.
    const thesisBranch =
      input.mode === "following"
        ? `select candidate.id,candidate.sort_at,'thesis'::text as item_kind
      from (select $1::uuid as author_id union select followed_user_id from user_follows where follower_user_id=$1::uuid) followed
      join users u on u.id=followed.author_id
      cross join lateral (
        select t.id,t.published_at as sort_at from user_theses t where t.author_id=followed.author_id and ${publicThesis}
          ${thesisFilters}
        order by t.published_at desc,t.id desc limit $8
      ) candidate order by candidate.sort_at desc,candidate.id desc limit $8`
        : input.marketId
          ? `select candidate.id,candidate.sort_at,'thesis'::text as item_kind from unified_markets scoped_market
          cross join lateral (select t.id,t.published_at as sort_at from user_theses t join users u on u.id=t.author_id
            where t.market_id=any(array[scoped_market.id]) and ${publicThesis}
              ${input.eventId ? "and t.event_id=$3::text" : ""} ${input.authorId ? "and t.author_id=$4::uuid" : ""}
              ${cursor ? "and (t.published_at,'thesis'::text,t.id)<($5::timestamptz,$6::text,$7::uuid)" : ""}
            order by t.market_id,t.published_at desc,t.id desc limit $8) candidate
          where scoped_market.id=$2::text order by candidate.sort_at desc,candidate.id desc limit $8`
          : input.eventId
            ? `select candidate.id,candidate.sort_at,'thesis'::text as item_kind from unified_events scoped_event
          cross join lateral (select t.id,t.published_at as sort_at from user_theses t join users u on u.id=t.author_id
            where t.event_id=any(array[scoped_event.id]) and ${publicThesis} ${input.authorId ? "and t.author_id=$4::uuid" : ""}
              ${cursor ? "and (t.published_at,'thesis'::text,t.id)<($5::timestamptz,$6::text,$7::uuid)" : ""}
            order by t.event_id,t.published_at desc,t.id desc limit $8) candidate
          where scoped_event.id=$3::text order by candidate.sort_at desc,candidate.id desc limit $8`
            : `select t.id,t.published_at as sort_at,'thesis'::text as item_kind from user_theses t join users u on u.id=t.author_id
      where ${publicThesis} ${thesisFilters} order by t.published_at desc,t.id desc limit $8`;
    const hunchBranch = input.eventId
      ? `select candidate.id,candidate.sort_at,'hunch'::text as item_kind from unified_markets m
      cross join lateral (select n.id,n.created_at as sort_at from ai_notes n where n.source_id=m.id and ${SOCIAL_PUBLIC_AI}
        ${cursor ? "and (n.created_at,'hunch'::text,n.id)<($5::timestamptz,$6::text,$7::uuid)" : ""}
        order by n.created_at desc,n.id desc limit $8) candidate
      where m.event_id=$3::text ${input.marketId ? "and m.id=$2::text" : ""} order by candidate.sort_at desc,candidate.id desc limit $8`
      : `select n.id,n.created_at as sort_at,'hunch'::text as item_kind from ai_notes n join unified_markets m on m.id=n.source_id
      where ${SOCIAL_PUBLIC_AI} ${input.marketId ? "and n.source_id=$2::text" : ""} ${input.eventId ? "and m.event_id=$3::text" : ""}
      ${cursor ? "and (n.created_at,'hunch'::text,n.id)<($5::timestamptz,$6::text,$7::uuid)" : ""} order by n.created_at desc,n.id desc limit $8`;
    const branches: string[] = [];
    if (input.source !== "hunch") branches.push(`(${thesisBranch})`);
    if (
      input.source !== "thesis" &&
      input.mode !== "following" &&
      !input.authorId
    )
      branches.push(`(${hunchBranch})`);
    if (!branches.length) return { items: [], nextCursor: null };
    const { rows } = await this.db.query(
      `with chosen as (${branches.join(" union all ")}) select id,item_kind,$1::uuid as viewer_id,$2::text as market_filter,$3::text as event_filter,$4::uuid as author_filter,$5::timestamptz as cursor_at,$6::text as cursor_kind,$7::uuid as cursor_id,sort_at::text as sort_at from chosen order by chosen.sort_at desc,item_kind desc,id desc limit $8`,
      values,
    );
    const selected = rows.slice(0, limit);
    const theses = await this.loadTheses(
      viewerId,
      selected.filter((row) => row.item_kind === "thesis").map((row) => row.id),
    );
    const hunches = await this.loadHunches(
      viewerId,
      selected.filter((row) => row.item_kind === "hunch").map((row) => row.id),
    );
    const byId = new Map(
      [...theses, ...hunches].map((item) => [`${item.kind}:${item.id}`, item]),
    );
    const last = selected.at(-1);
    return {
      items: selected.flatMap((row) => {
        const item = byId.get(`${row.item_kind}:${row.id}`);
        return item ? [item] : [];
      }),
      nextCursor:
        rows.length > limit && last
          ? encodeSocialCursor({
              scope,
              timestamp: last.sort_at,
              kind: last.item_kind,
              id: last.id,
            })
          : null,
    };
  }

  private async loadHunches(viewerId: string | null, ids: string[]) {
    if (!ids.length) return [];
    let copyEnabled = false;
    try {
      const { policy } = await resolveSocialPolicy(this.db);
      copyEnabled = policy.enabled && policy.copyEnabled;
    } catch (error) {
      if (!(error instanceof SocialPolicyUnavailableError)) throw error;
    }
    const { rows } = await this.db.query(
      `select n.id,n.note_type,n.title,n.description,n.created_at::text as published_at,n.source_id,m.event_id,n.lineage->>'side' as side,n.metrics #>> '{hunchStrengthV1,grade}' as strength,
      n.metrics->'socialInstrumentV1' as instrument_snapshot,m.venue,m.status,m.metadata,m.expiration_time,m.close_time,m.resolved_outcome,
      e.status as event_status,e.end_date as event_end_time,pm.accepting_orders as pm_accepting_orders,current_token.token_id as current_token_id,
      (select count(distinct ca.copier_user_id)::int from copy_attributions ca where ca.source_ai_note_id=n.id and ca.state='confirmed') as copy_count,
      (select count(*)::int from social_comments c join users u on u.id=c.author_id where c.ai_note_id=coalesce(valid_root.id,n.id)
        and c.author_hidden_at is null and c.moderation_hidden_at is null and ${publicAuthor} and ${noBlock}) as comment_count
      from ai_notes n join unified_markets m on m.id=n.source_id
      left join unified_events e on e.id=m.event_id
      left join polymarket_markets pm on m.venue='polymarket' and pm.id=m.venue_market_id
      left join unified_tokens current_token on current_token.token_id=n.metrics #>> '{socialInstrumentV1,tokenId}' and current_token.market_id=m.id and current_token.side=upper(n.lineage->>'side')
      ${SOCIAL_VALID_ROOT_JOIN}
      where n.id=any($2::uuid[]) and ${SOCIAL_PUBLIC_AI}`,
      [viewerId, ids],
    );
    return rows.map((row) => {
      const instrument = verifiedBuyFactsSchema.shape.instrument.safeParse(
        row.instrument_snapshot,
      );
      return {
        kind: "hunch" as const,
        id: row.id,
        noteType: row.note_type as "signal" | "context",
        title: row.title,
        summary: row.description,
        publishedAt: row.published_at,
        marketId: row.source_id,
        eventId: row.event_id,
        side: row.side === "YES" || row.side === "NO" ? row.side : null,
        strength:
          row.note_type === "context"
            ? ("neutral" as const)
            : row.strength === "strong"
              ? ("strong" as const)
              : ("good" as const),
        commentCount: row.comment_count,
        copyCount: row.copy_count,
        canCopy:
          copyEnabled &&
          row.note_type === "signal" &&
          instrument.success &&
          this.instrumentMatches(instrument.data, row) &&
          accepting(row),
      };
    });
  }

  private async commentTarget(
    db: DbQuery,
    viewerId: string | null,
    target: Target,
  ) {
    if (target.kind === "thesis") {
      const { rows } = await db.query(
        `select t.id,t.author_id from user_theses t join users u on u.id=t.author_id where t.id=$2 and ${publicThesis}`,
        [viewerId, target.id],
      );
      if (!rows[0]) throw new SocialError("thesis_not_found", 404);
      return { thesisId: target.id, aiNoteId: null, observedAiNoteId: null };
    }
    const { rows } = await db.query(
      `select n.id,coalesce(valid_root.id,n.id) as root_id from ai_notes n
      ${SOCIAL_VALID_ROOT_JOIN}
      where n.id=$1 and ${SOCIAL_PUBLIC_AI}`,
      [target.id],
    );
    if (!rows[0]) throw new SocialError("hunch_not_found", 404);
    return {
      thesisId: null,
      aiNoteId: rows[0].root_id as string,
      observedAiNoteId: target.id,
    };
  }

  async createComment(
    userId: string,
    input: { target: Target; body: string; idempotencyKey: string },
  ) {
    const hash = socialFingerprint([
      input.target,
      input.body.normalize("NFC").trim(),
    ]);
    return tx(this.db, async (db) => {
      await actor(db, userId, true);
      const existing = await db.query(
        `select id,payload_hash from social_comments where author_id=$1 and idempotency_key=$2`,
        [userId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== hash)
          throw new SocialError("idempotency_conflict", 409);
        return { id: existing.rows[0].id as string };
      }
      await actor(db, userId);
      const { policy } = await resolveSocialPolicy(db);
      if (!policy.enabled || !policy.commentsEnabled)
        throw new SocialError("comments_disabled", 503);
      await this.checkWrite(userId, policy, "comment");
      const body = socialText(input.body, policy.commentMaxGraphemes);
      const target = await this.commentTarget(db, userId, input.target);
      const { rows } = await db.query(
        `insert into social_comments(author_id,thesis_id,ai_note_id,observed_ai_note_id,body,idempotency_key,payload_hash) values($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          userId,
          target.thesisId,
          target.aiNoteId,
          target.observedAiNoteId,
          body,
          input.idempotencyKey,
          hash,
        ],
      );
      return { id: rows[0].id as string };
    });
  }

  async listComments(
    viewerId: string | null,
    input: Page & { targetKind: "thesis" | "hunch"; targetId: string },
  ) {
    const target = await this.commentTarget(this.db, viewerId, {
      kind: input.targetKind,
      id: input.targetId,
    });
    const policy = await readPagePolicy(this.db);
    const limit = limitFor(input.limit, policy);
    const scope = socialFingerprint([
      "comments",
      viewerId,
      target.thesisId,
      target.aiNoteId,
    ]);
    const cursor = decodeSocialCursor(input.cursor, scope);
    const { rows } = await this.db.query(
      `select c.id as comment_id,c.body,c.created_at::text as comment_created_at,c.observed_ai_note_id,(${SOCIAL_PUBLIC_AI}) as revision_available,${profileColumns}
      from social_comments c join users u on u.id=c.author_id left join content_assets a on a.id=u.avatar_asset_id and a.status='ready'
      left join ai_notes n on n.id=c.observed_ai_note_id
      where (${target.thesisId ? "c.thesis_id=$2::uuid" : "c.ai_note_id=$2::uuid"}) and c.author_hidden_at is null and c.moderation_hidden_at is null and ${publicAuthor} and ${noBlock}
      and ($3::timestamptz is null or (c.created_at,c.id)<($3::timestamptz,$4::uuid)) order by c.created_at desc,c.id desc limit $5`,
      [
        viewerId,
        target.thesisId ?? target.aiNoteId,
        cursor?.timestamp ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.comment_id,
        author: profile(row),
        body: row.body,
        createdAt: row.comment_created_at,
        observedRevisionId: row.observed_ai_note_id,
        revisionAvailable:
          !row.observed_ai_note_id || Boolean(row.revision_available),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeSocialCursor({
              scope,
              timestamp: last.comment_created_at,
              kind: "comment",
              id: last.comment_id,
            })
          : null,
    };
  }

  async hideComment(userId: string, id: string) {
    const { rows } = await this.db.query(
      `update social_comments set author_hidden_at=coalesce(author_hidden_at,now()) where id=$1 and author_id=$2 returning id`,
      [id, userId],
    );
    if (!rows[0]) throw new SocialError("comment_not_found", 404);
    return { ok: true as const };
  }

  async report(
    userId: string,
    input: {
      targetKind: "profile" | "thesis" | "comment";
      targetId: string;
      reason: string;
    },
  ) {
    return tx(this.db, async (db) => {
      await actor(db, userId, true);
      const { policy } = await resolveSocialPolicy(db);
      await this.checkWrite(userId, policy, "report");
      const reason = socialText(input.reason, policy.reportMaxGraphemes);
      if (input.targetKind === "profile") {
        // Keep this lightweight visibility check on the transaction connection.
        // Public profile hydration/statistics acquire the pool independently.
        const target = await db.query(
          `select u.id from users u where u.id=$2 and ${publicAuthor} and ${noBlock}`,
          [userId, input.targetId],
        );
        if (!target.rows[0]) throw new SocialError("profile_not_found", 404);
      } else if (input.targetKind === "thesis")
        await this.commentTarget(db, userId, {
          kind: "thesis",
          id: input.targetId,
        });
      else {
        const { rows } = await db.query(
          `select c.thesis_id,c.observed_ai_note_id from social_comments c join users u on u.id=c.author_id where c.id=$2 and c.author_hidden_at is null and c.moderation_hidden_at is null and ${publicAuthor} and ${noBlock}`,
          [userId, input.targetId],
        );
        if (!rows[0]) throw new SocialError("comment_not_found", 404);
        await this.commentTarget(db, userId, {
          kind: rows[0].thesis_id ? "thesis" : "hunch",
          id: rows[0].thesis_id ?? rows[0].observed_ai_note_id,
        });
      }
      const targetColumn = {
        profile: "target_profile_id",
        thesis: "thesis_id",
        comment: "comment_id",
      }[input.targetKind];
      const { rows } = await db.query(
        `insert into social_reports(reporter_id,${targetColumn},reason,target_kind,target_id) values($1,$2,$3,$4,$2)
        on conflict(reporter_id,target_kind,target_id) do update set reason=social_reports.reason returning id`,
        [
          userId,
          input.targetId,
          reason,
          input.targetKind === "profile" ? "user" : input.targetKind,
        ],
      );
      return { id: rows[0].id as string };
    });
  }
}
