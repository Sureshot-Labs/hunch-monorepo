import { randomUUID } from "node:crypto";
import { collectProductSeeds } from "./product-seeds.js";
import type { Pool } from "pg";
import {
  eligible,
  hash,
  outcomeCandidates,
  readPolicy,
  type Contract,
} from "./contracts.js";
import {
  enqueue,
  loadContracts,
  loadEvent,
  withTransaction,
  type Db,
} from "./store.js";

import {
  approvalRevision,
  readMatchingPolicy,
  matchingWorkerEnabled,
  type MarketMatchingPolicy,
} from "./policy.js";
export type InterestStatus = "pending" | "cached" | "limited" | "unavailable";
const liveSql = `m.status='ACTIVE' and m.resolved_outcome is null
  and (m.close_time is null or m.close_time>now()) and (m.expiration_time is null or m.expiration_time>now())
  and e.status='ACTIVE' and (e.end_date is null or e.end_date>now())`;
const primaryVector = (alias: string) =>
  `(setweight(to_tsvector('english',coalesce(${alias}.title,'')),'A') || setweight(to_tsvector('english',coalesce(${alias}.category,'')),'B'))`;

/** Caller supplies trusted identity, never a user-controlled actor ID. */
export async function requestInterest(
  pool: Pool,
  marketId: string,
  actorId: string,
): Promise<InterestStatus> {
  if (!actorId || marketId.length > 200) return "unavailable";
  return withTransaction(pool, async (db) => {
    await db.query("set local statement_timeout='1500ms'");
    const matching = await readMatchingPolicy(db);
    if (
      !matchingWorkerEnabled(matching) ||
      !matching.lazyEnabled ||
      !matching.alternativesEnabled ||
      process.env.MATCHING_LAZY_ENABLED === "false"
    )
      return "unavailable";
    if (!(await lockDemand(db))) return "limited";
    return putInterest(
      db,
      marketId,
      "lazy",
      matching,
      hash(["matching-demand", actorId]),
    );
  });
}
async function lockDemand(db: Db) {
  return (
    await db.query(
      "select pg_try_advisory_xact_lock(hashtext('matching-demand')) as acquired",
    )
  ).rows[0].acquired;
}
async function putInterest(
  db: Db,
  marketId: string,
  source: "warm" | "lazy",
  matching: MarketMatchingPolicy,
  actorHash?: string,
): Promise<InterestStatus> {
  const current = await db.query(
    "select *,next_attempt_at>now() as cooling from market_matching_interest where market_id=$1",
    [marketId],
  );
  const row = current.rows[0];
  // Trusted existing-job promotion precedes interest cooldown/capacity checks.
  if (source === "warm") {
    if (row?.source === "lazy")
      await db.query(
        "update market_matching_interest set source='warm' where market_id=$1",
        [marketId],
      );
    // Existing admitted work needs no new capacity and keeps attempts/leases.
    await db.query(
      `update market_matching_jobs set candidate_source='warm' where status='queued' and candidate_source='lazy' and policy_version=$2 and (
          (entity_kind='contract' and (left_id=$1 or right_id=$1)) or
          (entity_kind='event' and (left_id=(select event_id from unified_markets where id=$1) or right_id=(select event_id from unified_markets where id=$1))))`,
      [marketId, approvalRevision(matching)],
    );
  }
  if (row && (row.status !== "done" || row.cooling)) {
    if (row.status !== "done") return "pending";
    const waiting = await db.query(
      "select 1 from market_matching_jobs where entity_kind='contract' and status in ('queued','running') and (left_id=$1 or right_id=$1) limit 1",
      [marketId],
    );
    return waiting.rows.length ? "pending" : "cached";
  }
  const capacity = await db.query(
    `select count(*)::int as stored_count,count(*) filter(where status<>'done')::int as pending,
      count(*) filter(where source='lazy')::int as lazy_stored,
      count(*) filter(where source='lazy' and status<>'done')::int as lazy_pending from market_matching_interest`,
  );
  if (
    capacity.rows[0].pending >= matching.pendingInterests ||
    (!row && capacity.rows[0].stored_count >= matching.storedInterests)
  )
    return "limited";
  if (
    source === "lazy" &&
    (capacity.rows[0].lazy_pending >= matching.lazyPendingInterests ||
      (!row && capacity.rows[0].lazy_stored >= matching.lazyStoredInterests))
  )
    return "limited";
  if (source === "lazy") {
    const usage = await db.query(
      `select count(*)::int as daily,count(*) filter(where requested_at>now()-interval '1 hour')::int as hourly from market_matching_demand_limits where actor_hash=$1 and requested_at>now()-interval '24 hours'`,
      [actorHash],
    );
    if (
      usage.rows[0].daily >= matching.actorDailyMarkets ||
      usage.rows[0].hourly >= matching.actorHourlyMarkets
    )
      return "limited";
  }
  const found = await db.query(
    `select m.venue from unified_markets m join unified_events e on e.id=m.event_id where m.id=$1 and ${liveSql}`,
    [marketId],
  );
  if (
    !found.rows[0] ||
    !matching.venues.includes(found.rows[0].venue) ||
    !eligible(await readPolicy(db), found.rows[0].venue)
  )
    return "unavailable";
  if (source === "lazy")
    await db.query(
      `insert into market_matching_demand_limits(actor_hash,market_id) values($1,$2) on conflict(actor_hash,market_id) do update set requested_at=now()`,
      [actorHash, marketId],
    );
  await db.query(
    `insert into market_matching_interest(market_id,source) values($1,$2) on conflict(market_id) do update set source=excluded.source,status='queued',attempts=0,next_attempt_at=now(),requested_at=now(),last_error=null`,
    [marketId, source],
  );
  return "pending";
}

/** Small source list; the existing trending-prefix index bounds the broad venue read. */
export async function warmInterest(pool: Pool) {
  const initial = await readMatchingPolicy(pool);
  if (!matchingWorkerEnabled(initial)) return 0;
  const recent = await pool.query(
    "select 1 from market_matching_state where state_key='warm' and updated_at>now()-($1*interval '1 second')",
    [initial.warmIntervalSeconds],
  );
  if (recent.rows.length) return 0;
  // Network reads happen outside the demand transaction. Never hold DB locks while
  // loading product selections, and never invoke inference from those selectors.
  const product = await collectProductSeeds(
    initial,
    process.env.MATCHING_DISCOVERY_API_URL,
  );
  return withTransaction(pool, async (db) => {
    await db.query("set local statement_timeout='5s'");
    const matching = await readMatchingPolicy(db);
    if (!matchingWorkerEnabled(matching)) return 0;
    if (hash(matching) !== hash(initial)) return 0;
    if (!(await lockDemand(db))) return 0;
    const state = await db.query(
      "select 1 from market_matching_state where state_key='warm' and updated_at>now()-($1*interval '1 second')",
      [matching.warmIntervalSeconds],
    );
    if (state.rows.length) return 0;
    await db.query(
      "delete from market_matching_demand_limits where requested_at<now()-interval '24 hours'",
    );
    await db.query(
      "delete from market_matching_interest where status='done' and requested_at<now()-interval '7 days'",
    );
    const prefix = await db.query(
      `with prefix_rows as materialized (
      select id,venue,(coalesce(case when volume_total is not null and volume_total>0 then volume_total else null end,0)*0.4 + coalesce(coalesce(nullif(liquidity,0),nullif(open_interest,0)),0)*0.3) as warm_score from unified_markets where status='ACTIVE'
      and (venue<>'kalshi' or lower(coalesce(metadata->>'dflowNativeAcceptingOrders','false'))='true')
      and (coalesce(volume_total,0)>0 or coalesce(volume_24h,0)>0 or coalesce(liquidity,0)>0 or coalesce(open_interest,0)>0 or best_bid is not null or best_ask is not null or last_price is not null)
      order by (coalesce(case when volume_total is not null and volume_total>0 then volume_total else null end,0)*0.4 + coalesce(coalesce(nullif(liquidity,0),nullif(open_interest,0)),0)*0.3) desc nulls last,id limit $1
    ) select p.id from prefix_rows p join unified_markets m on m.id=p.id join unified_events e on e.id=m.event_id
    where p.venue=any($3::text[]) and ${liveSql} order by p.warm_score desc nulls last,p.id limit $2`,
      [
        matching.warmTrendingCount ? matching.warmPrefixCount : 0,
        matching.warmPrefixCount,
        matching.venues,
      ],
    );
    // Limitless has unknown liquidity/24h volume. Its bounded native catalog is a separate allocation.
    const native = await db.query(
      `select m.id from unified_markets m join unified_events e on e.id=m.event_id where m.venue='limitless' and ${liveSql} and m.volume_total>=$1 order by m.volume_total desc,m.id limit $2`,
      [
        matching.warmLimitlessMinVolumeUsd,
        matching.venues.includes("limitless") && matching.warmLimitlessCount
          ? matching.warmLimitlessPoolSize
          : 0,
      ],
    );
    const pools = {
      ...product.pools,
      trending: prefix.rows.map((r) => r.id as string),
      limitless: native.rows.map((r) => r.id as string),
    };
    const quotas = {
      feed: matching.seedFeedCount,
      map: matching.seedMapCount,
      whales: matching.seedWhalesCount,
      trending: matching.warmTrendingCount,
      limitless: matching.warmLimitlessCount,
    };
    const lifecycle = await readPolicy(db);
    const venues = matching.venues.filter((v) => eligible(lifecycle, v));
    // One bounded lookup before quotas: repeated top rows must not hide unseen
    // markets deeper in a product pool. Lazy rows remain eligible for promotion
    // even while cooling or pending, including when the queue is full.
    const availability = await db.query<{
      id: string;
      priority: number;
      requested_at: Date | null;
      unseen: boolean;
      needs_admission: boolean;
    }>(
      `select m.id,case when interest_row.source='lazy' then 0 when interest_row.market_id is null then 1 else 2 end as priority,interest_row.requested_at,
       interest_row.market_id is null as unseen,
       (interest_row.market_id is null or (interest_row.status='done' and interest_row.next_attempt_at<=now())) as needs_admission
       from unified_markets m join unified_events e on e.id=m.event_id
       left join market_matching_interest interest_row on interest_row.market_id=m.id
       where m.id=any($1::text[]) and m.venue=any($2::text[]) and ${liveSql}
       and (interest_row.market_id is null or interest_row.source='lazy' or (interest_row.status='done' and interest_row.next_attempt_at<=now()))`,
      [[...new Set(Object.values(pools).flat())], venues],
    );
    const available = new Map(availability.rows.map((row) => [row.id, row]));
    const capacity = (
      await db.query(
        "select count(*)::int as stored_count,count(*) filter(where status<>'done')::int as pending from market_matching_interest",
      )
    ).rows[0];
    let storedSlots = Math.max(
      0,
      matching.storedInterests - capacity.stored_count,
    );
    let pendingSlots = Math.max(
      0,
      matching.pendingInterests - capacity.pending,
    );
    const ids = new Set<string>();
    const selectedCounts: Record<string, number> = {};
    for (const source of Object.keys(pools) as (keyof typeof pools)[]) {
      const ranked = pools[source]
        .filter((id) => available.has(id))
        .sort((a, b) => {
          const left = available.get(a),
            right = available.get(b);
          if (!left || !right) return 0;
          return (
            left.priority - right.priority ||
            (left.priority === 2
              ? Number(left.requested_at) - Number(right.requested_at)
              : 0)
          );
        });
      let selected = 0;
      for (const id of ranked) {
        if (selected >= quotas[source] || ids.size >= matching.warmBatchSize)
          break;
        if (ids.has(id)) continue;
        const candidate = available.get(id);
        if (!candidate) continue;
        // Saturated storage must not let unseen rows starve due stored work.
        // Lazy promotions remain admissible without consuming new capacity.
        if (
          candidate.needs_admission &&
          candidate.priority !== 0 &&
          (!pendingSlots || (candidate.unseen && !storedSlots))
        )
          continue;
        if (
          candidate.needs_admission &&
          pendingSlots &&
          (!candidate.unseen || storedSlots)
        ) {
          pendingSlots--;
          if (candidate.unseen) storedSlots--;
        }
        ids.add(id);
        selected++;
      }
      selectedCounts[source] = selected;
    }
    let queued = 0;
    for (const id of ids)
      if ((await putInterest(db, id, "warm", matching)) === "pending") queued++;
    await db.query(
      "insert into market_matching_state(state_key,payload) values('warm',$1) on conflict(state_key) do update set payload=excluded.payload,updated_at=now()",
      [
        {
          selected: ids.size,
          selectedCounts,
          poolCounts: Object.fromEntries(
            Object.entries(pools).map(([source, rows]) => [
              source,
              rows.length,
            ]),
          ),
          queued,
          product: {
            counts: product.counts,
            unavailable: product.unavailable,
            configured: product.configured,
          },
        },
      ],
    );
    return queued;
  });
}

export function compatibleContext(
  a: string,
  b: string,
  overlap = 0.5,
): boolean {
  const years = (s: string) =>
    [...new Set(s.match(/\b20\d{2}\b/g) ?? [])].sort().join();
  if (years(a) && years(b) && years(a) !== years(b)) return false;
  const stages = (s: string) =>
    /\b(inaugurat\w*|nomina\w*|primar\w*|general election)\b/i
      .exec(s)?.[0]
      .toLowerCase();
  if (stages(a) && stages(b) && stages(a) !== stages(b)) return false;
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter(
          (x) =>
            ![
              "the",
              "a",
              "an",
              "will",
              "be",
              "who",
              "what",
              "is",
              "in",
              "on",
              "of",
              "to",
              "by",
              "after",
            ].includes(x),
        ) ?? [],
    );
  const left = words(a),
    right = words(b);
  return (
    left.size > 0 &&
    right.size > 0 &&
    [...left].filter((x) => right.has(x)).length /
      Math.max(left.size, right.size) >=
      overlap
  );
}
export function admitContract(
  a: Contract,
  b: Contract,
  overlap = 0.5,
  sameVenue = false,
) {
  const words = (s: string) =>
    new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a.selection),
    right = words(b.selection);
  const contains = (small: Set<string>, large: Set<string>) =>
    small.size > 0 && [...small].every((word) => large.has(word));
  // Candidate admission only: a full question may contain the selected child
  // (Anthropic / a deadline / $700M). This never approves an outcome mapping.
  const boundSelection = contains(left, right) || contains(right, left);
  return (
    a.id !== b.id &&
    (sameVenue || a.venue !== b.venue) &&
    a.status === "ACTIVE" &&
    b.status === "ACTIVE" &&
    compatibleContext(a.event, b.event, overlap) &&
    a.rules.length > 0 &&
    b.rules.length > 0 &&
    (outcomeCandidates(a, b).length > 0 || boundSelection)
  );
}

export async function discover(
  db: Db,
  source: Contract,
  suppliedPolicy?: MarketMatchingPolicy,
) {
  const matching = suppliedPolicy ?? (await readMatchingPolicy(db));
  const policy = await readPolicy(db);
  const venues = matching.venues.filter(
    (v) =>
      (matching.sameVenueEnabled || v !== source.venue) && eligible(policy, v),
  );
  if (
    !matching.venues.some((v) => v === source.venue) ||
    !eligible(policy, source.venue) ||
    !venues.length
  )
    return { events: [], contracts: [] };
  const events = await db.query<{ id: string; title: string }>(
    `select e.id,e.title from unified_events e where e.id<>$4 and e.status='ACTIVE' and e.venue=any($2::text[]) and (e.end_date is null or e.end_date>now()) and ${primaryVector("e")} @@ plainto_tsquery('english',$1) order by ts_rank(${primaryVector("e")},plainto_tsquery('english',$1)) desc,e.id limit $3`,
    [source.event, venues, matching.retrievalLimit, source.eventId],
  );
  const eventIds = events.rows
    .filter((e) =>
      compatibleContext(source.event, e.title, matching.contextOverlap),
    )
    .slice(0, matching.eventCandidates)
    .map((e) => e.id);
  const claims = [
    ...new Set(
      [
        source.selection,
        ...source.outcomes.filter((o) => o.side === null).map((o) => o.label),
      ].map((s) => s.trim().toLowerCase()),
    ),
  ]
    .filter(Boolean)
    .slice(0, 16);
  const childIds = eventIds.length
    ? await db.query<{ id: string }>(
        `select m.id from unified_markets m join unified_events e on e.id=m.event_id where m.event_id=any($1::text[]) and ${liveSql} and (lower(trim(m.title))=any($2::text[]) or exists(select 1 from jsonb_array_elements_text(case when pg_input_is_valid(m.outcomes::text,'jsonb') then case when jsonb_typeof(m.outcomes::jsonb)='array' then m.outcomes::jsonb else '[]'::jsonb end else '[]'::jsonb end) outcome_labels(outcome_label) where lower(trim(outcome_labels.outcome_label))=any($2::text[]))) order by m.id limit $3`,
        [eventIds, claims, matching.retrievalLimit],
      )
    : { rows: [] };
  // Independent contract FTS keeps event retrieval from being a mandatory gate.
  const direct = await db.query<{ id: string }>(
    `select m.id from unified_markets m join unified_events e on e.id=m.event_id where m.id<>$4 and m.venue=any($2::text[]) and ${liveSql} and ${primaryVector("m")} @@ plainto_tsquery('english',$1) order by ts_rank(${primaryVector("m")},plainto_tsquery('english',$1)) desc,m.id limit $3`,
    [
      `${source.selection} ${source.event}`,
      venues,
      matching.retrievalLimit,
      source.id,
    ],
  );
  let targets = await loadContracts(db, [
    ...new Set([...childIds.rows, ...direct.rows].map((r) => r.id)),
  ]);
  if (
    !targets.some((target) =>
      admitContract(
        source,
        target,
        matching.contextOverlap,
        matching.sameVenueEnabled,
      ),
    )
  ) {
    // Narrow rescue for flat questions versus grouped children. A single lexical
    // anchor still uses the existing primary GIN indexes; context/selection checks
    // then reject unrelated hits. No description scan or all-pairs expansion.
    const anchor = source.event
      .match(/[\p{L}][\p{L}\p{N}]*/gu)
      ?.find(
        (word) =>
          !/^(will|who|what|which|when|the|a|an|is|are|does|do|how|many|much|by|before|after|in|on|of|to)$/i.test(
            word,
          ),
      );
    if (anchor) {
      const rescue = await db.query<{ id: string }>(
        `with anchor_events as materialized (
          select e.id from unified_events e where e.status='ACTIVE' and e.venue=any($2::text[]) and (e.end_date is null or e.end_date>now()) and ${primaryVector("e")} @@ plainto_tsquery('english',$1)
          order by ts_rank(${primaryVector("e")},plainto_tsquery('english',$3)) desc,e.id limit $6
        ), anchor_children as (
          select chosen.id from anchor_events ae cross join lateral (
            select m.id from unified_markets m join unified_events e on e.id=m.event_id where m.event_id=ae.id and ${liveSql}
            order by (lower(trim(m.title))=any($5::text[])) desc,m.id limit $4
          ) chosen
        ), anchor_markets as (
          select m.id from unified_markets m join unified_events e on e.id=m.event_id where m.venue=any($2::text[]) and ${liveSql} and ${primaryVector("m")} @@ plainto_tsquery('english',$1)
          order by ts_rank(${primaryVector("m")},plainto_tsquery('english',$3)) desc,m.id limit $4
        ) select id from anchor_children union select id from anchor_markets`,
        [
          anchor,
          venues,
          source.event,
          matching.retrievalLimit,
          claims,
          Math.min(3, matching.retrievalLimit),
        ],
      );
      targets = await loadContracts(db, [
        ...new Set(rescue.rows.map((row) => row.id)),
      ]);
    }
  }
  return {
    events: eventIds,
    contracts: targets
      .filter((t) =>
        admitContract(
          source,
          t,
          matching.contextOverlap,
          matching.sameVenueEnabled,
        ),
      )
      .slice(0, matching.contractCandidates),
  };
}

export async function runDiscovery(pool: Pool) {
  const matching = await readMatchingPolicy(pool);
  if (!matchingWorkerEnabled(matching)) return "disabled";
  await pool.query(
    "update market_matching_interest set status='done',next_attempt_at=now()+($1*interval '1 second'),lease_token=null,last_error='lease_attempts_exhausted' where status='running' and lease_until<now() and attempts>=$2",
    [matching.cooldownSeconds, matching.attempts],
  );
  const token = randomUUID();
  const claim = await pool.query(
    `with due_interest as (select market_id from market_matching_interest where (status='queued' or (status='running' and lease_until<now())) and next_attempt_at<=now() and ($2 or source<>'lazy') order by (source='warm') desc,requested_at for update skip locked limit 1)
    update market_matching_interest i set status='running',lease_token=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 from due_interest d where i.market_id=d.market_id returning i.*`,
    [
      token,
      matching.lazyEnabled &&
        matching.alternativesEnabled &&
        process.env.MATCHING_LAZY_ENABLED !== "false",
    ],
  );
  const item = claim.rows[0];
  if (!item) return "idle";
  try {
    return await withTransaction(pool, async (db) => {
      await db.query("set local statement_timeout='3s'");
      if (!(await lockDemand(db))) throw new Error("discovery_busy");
      const backlog = await db.query(
        "select count(*)::int as total,count(*) filter(where candidate_source='lazy')::int as lazy_count from market_matching_jobs where status in ('queued','running')",
      );
      if (
        backlog.rows[0].total +
          matching.eventCandidates +
          matching.contractCandidates >
          matching.queuedJobs ||
        (item.source === "lazy" &&
          backlog.rows[0].lazy_count +
            matching.eventCandidates +
            matching.contractCandidates >
            matching.lazyQueuedJobs)
      )
        throw new Error("discovery_backpressure");
      const seed = (await loadContracts(db, [item.market_id]))[0];
      const live = await db.query(
        `select 1 from unified_markets m join unified_events e on e.id=m.event_id where m.id=$1 and ${liveSql}`,
        [item.market_id],
      );
      const found =
        seed && live.rows.length
          ? await discover(db, seed, matching)
          : { events: [], contracts: [] };
      // Verify ownership before any effects: a reclaimed lease cannot enqueue.
      const lease = await db.query(
        "select 1 from market_matching_interest where market_id=$1 and lease_token=$2 and lease_until>now() for update",
        [item.market_id, token],
      );
      if (!lease.rows.length) return "lease_lost";
      if (seed) {
        for (const target of found.contracts)
          await enqueue(db, "contract", seed, target, item.source, matching);
        const sourceEvent = found.events.length
          ? await loadEvent(db, seed.eventId)
          : null;
        if (sourceEvent)
          for (const id of found.events) {
            const target = await loadEvent(db, id);
            if (target)
              await enqueue(
                db,
                "event",
                sourceEvent,
                target,
                item.source,
                matching,
              );
          }
      }
      await db.query(
        "update market_matching_interest set status='done',checked_at=now(),next_attempt_at=now()+($3*interval '1 second'),lease_token=null,lease_until=null,last_error=null where market_id=$1 and lease_token=$2",
        [item.market_id, token, matching.cooldownSeconds],
      );
      return "completed";
    });
  } catch (error) {
    const deferred =
      error instanceof Error &&
      ["discovery_busy", "discovery_backpressure"].includes(error.message);
    if (deferred) {
      await pool.query(
        "update market_matching_interest set status='queued',attempts=greatest(0,attempts-1),next_attempt_at=now()+interval '5 minutes',lease_token=null,lease_until=null,last_error=$3 where market_id=$1 and lease_token=$2",
        [item.market_id, token, error.message],
      );
      return "deferred";
    }
    await pool.query(
      "update market_matching_interest set status=case when attempts>=$3 then 'done' else 'queued' end,next_attempt_at=now()+case when attempts>=$3 then ($4*interval '1 second') else interval '5 minutes' end,lease_token=null,lease_until=null,last_error='discovery_failed' where market_id=$1 and lease_token=$2",
      [item.market_id, token, matching.attempts, matching.cooldownSeconds],
    );
    return "retry";
  }
}

/** Revisit only existing verified relationships, with a persisted bounded cursor. */
export async function revalidateLinks(pool: Pool) {
  return withTransaction(pool, async (db) => {
    await db.query("set local statement_timeout='3s'");
    const matching = await readMatchingPolicy(db);
    if (!matchingWorkerEnabled(matching)) return 0;
    if (!(await lockDemand(db))) return 0;
    const state = await db.query(
      "select payload,updated_at>now()-($1*interval '1 second') as cooling from market_matching_state where state_key='revalidate'",
      [matching.revalidateIntervalSeconds],
    );
    if (state.rows[0]?.cooling || !matching.revalidateCount) return 0;
    const cursor = state.rows[0]?.payload?.cursor ?? "";
    const links = await db.query(
      `select * from (select 'contract:'||ml.id as cursor_key,'contract' as entity_kind,ml.left_id,ml.right_id from market_links ml
      where ml.disposition='approved' or (ml.disposition='review' and exists (
        select 1 from matching_evaluations evaluation_row where evaluation_row.id=ml.evaluation_id
          and evaluation_row.diagnostics->'blockers' ? 'unresolved_parent_rules'))
      union all select 'event:'||id,'event',left_id,right_id from event_links where disposition='approved') link_rows where cursor_key>$1 order by cursor_key limit $2`,
      [cursor, matching.revalidateCount],
    );
    for (const link of links.rows) {
      if (link.entity_kind === "contract") {
        const pair = await loadContracts(db, [link.left_id, link.right_id]);
        if (pair.length === 2)
          await enqueue(
            db,
            "contract",
            pair[0],
            pair[1],
            "revalidation",
            matching,
          );
      } else {
        const a = await loadEvent(db, link.left_id),
          b = await loadEvent(db, link.right_id);
        if (a && b) await enqueue(db, "event", a, b, "revalidation", matching);
      }
    }
    await db.query(
      "insert into market_matching_state(state_key,payload) values('revalidate',$1) on conflict(state_key) do update set payload=excluded.payload,updated_at=now()",
      [
        {
          cursor:
            links.rows.length < matching.revalidateCount
              ? ""
              : links.rows.at(-1).cursor_key,
        },
      ],
    );
    return links.rows.length;
  });
}
