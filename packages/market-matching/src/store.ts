import {
  readMatchingPolicy,
  approvalRevision,
  type MarketMatchingPolicy,
} from "./policy.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  hash,
  normalizeContract,
  normalizeEvent,
  eligible,
  readPolicy,
  POLICY_VERSION,
  type Contract,
  type EventContract,
  type EntityKind,
  type MarketRow,
} from "./contracts.js";

export type Db = Pick<Pool, "query">;
export type Snapshot = Contract | EventContract;
export type Job = {
  id: string;
  entity_kind: EntityKind;
  left_id: string;
  right_id: string;
  left_version: string;
  right_version: string;
  attempts: number;
  lease_token: string;
  candidate_source: string;
  policy_version: string;
};
const marketSelect = `select m.id,m.event_id,m.venue,m.title,m.description,m.status,m.outcomes,m.close_time,m.expiration_time,e.end_date as event_end_date,
  jsonb_build_object('question',m.metadata->>'question','rulesPrimary',m.metadata->>'rulesPrimary','rulesSecondary',m.metadata->>'rulesSecondary') as metadata,
  e.title as event_title, e.description as event_description,
  case when e.end_date<=now() then 'CLOSED' else e.status::text end as event_status,
  case when m.resolved_outcome is not null or m.close_time<=now() or m.expiration_time<=now() then 'CLOSED' else m.status::text end as matching_status,
  coalesce((select jsonb_agg(jsonb_build_object('id',sibling.id,'selection',sibling.title) order by sibling.id) from unified_markets sibling where sibling.event_id=m.event_id),'[]'::jsonb) as event_members,
  coalesce((select jsonb_agg(jsonb_build_object('token_id',mt.token_id,'outcome_side',mt.outcome_side) order by mt.token_id)
    from unified_market_tokens mt where mt.market_id=m.id),'[]'::jsonb) as tokens
  from unified_markets m join unified_events e on e.id=m.event_id`;
export async function loadContracts(
  db: Db,
  ids: string[],
): Promise<Contract[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<MarketRow>(
    `${marketSelect} where m.id=any($1::text[])`,
    [ids],
  );
  return rows.map(normalizeContract);
}
export async function loadEvent(
  db: Db,
  id: string,
): Promise<EventContract | null> {
  const { rows } = await db.query(
    `select id,venue,title,description,status,case when end_date<=now() then 'CLOSED' else status::text end as matching_status from unified_events where id=$1`,
    [id],
  );
  if (!rows[0]) return null;
  const markets = await db.query<MarketRow>(
    `${marketSelect} where m.event_id=$1`,
    [id],
  );
  return normalizeEvent(rows[0], markets.rows.map(normalizeContract));
}
export async function loadSnapshot(
  db: Db,
  kind: EntityKind,
  id: string,
): Promise<Snapshot | null> {
  return kind === "event"
    ? loadEvent(db, id)
    : ((await loadContracts(db, [id]))[0] ?? null);
}
export function versionId(s: Snapshot): string {
  return hash([s.id, s.fingerprint, POLICY_VERSION]);
}
export async function saveVersion(
  db: Db,
  kind: EntityKind,
  s: Snapshot,
): Promise<string> {
  const id = versionId(s);
  if (kind === "event")
    await db.query(
      `insert into event_match_versions(id,event_id,fingerprint,"snapshot") values($1,$2,$3,$4) on conflict do nothing`,
      [id, s.id, s.fingerprint, s],
    );
  else
    await db.query(
      `insert into market_contract_versions(id,market_id,event_id,fingerprint,"snapshot") values($1,$2,$3,$4,$5) on conflict do nothing`,
      [id, s.id, (s as Contract).eventId, s.fingerprint, s],
    );
  return id;
}
export async function enqueue(
  db: Db,
  kind: EntityKind,
  a: Snapshot,
  b: Snapshot,
  source: string,
  suppliedPolicy?: MarketMatchingPolicy,
): Promise<void> {
  const matching = suppliedPolicy ?? (await readMatchingPolicy(db));
  if (a.id === b.id || (!matching.sameVenueEnabled && a.venue === b.venue))
    return;
  const revision = approvalRevision(matching);
  const [left, right] = a.id < b.id ? [a, b] : [b, a];
  const lv = await saveVersion(db, kind, left),
    rv = await saveVersion(db, kind, right);
  const jobId = hash([kind, lv, rv, revision]);
  // Trusted re-selection can promote the exact queued pair even at queue capacity.
  // Keep attempts/backoff and never steal a running lease or repeat completed work.
  if (source === "warm" || source === "revalidation")
    await db.query(
      "update market_matching_jobs set candidate_source=$2 where id=$1 and status='queued' and candidate_source='lazy'",
      [jobId, source],
    );
  await db.query(
    `insert into market_matching_jobs(id,entity_kind,left_id,right_id,left_version,right_version,candidate_source,policy_version)
    select $1,$2,$3,$4,$5,$6,$7,$8 where (select count(*) from market_matching_jobs where status in ('queued','running'))<$9
      and ($7<>'lazy' or (select count(*) from market_matching_jobs where status in ('queued','running') and candidate_source='lazy')<$10)
      on conflict(id) do update set status='queued',attempts=0,next_attempt_at=now(),lease_token=null,lease_until=null,last_error=null,candidate_source=excluded.candidate_source where market_matching_jobs.status='stale'`,
    [
      jobId,
      kind,
      left.id,
      right.id,
      lv,
      rv,
      source,
      revision,
      matching.queuedJobs,
      matching.lazyQueuedJobs,
    ],
  );
}
export async function candidates(
  db: Db,
  kind: EntityKind,
  s: Snapshot,
): Promise<string[]> {
  if (kind === "contract") {
    const { discover } = await import("./discovery.js");
    return (await discover(db, s as Contract)).contracts.map((c) => c.id);
  }
  const policy = await readPolicy(db);
  const matching = await readMatchingPolicy(db);
  const venues = matching.venues.filter(
    (v) => (matching.sameVenueEnabled || v !== s.venue) && eligible(policy, v),
  );
  const vector =
    "(setweight(to_tsvector('english',coalesce(title,'')),'A') || setweight(to_tsvector('english',coalesce(category,'')),'B'))";
  const { rows } = await db.query<{ id: string }>(
    `select id from unified_events where id<>$4 and status='ACTIVE' and venue=any($2::text[]) and ${vector} @@ plainto_tsquery('english',$1) order by id limit $3`,
    [(s as EventContract).title, venues, matching.eventCandidates, s.id],
  );
  return rows.map((r) => r.id);
}

export async function claim(
  pool: Pool,
  attempts = 3,
  allowLazy = true,
): Promise<Job | null> {
  await pool.query(
    "update market_matching_jobs set status='error',last_error='attempts_exhausted',lease_token=null,lease_until=null where attempts>=$1 and (status='queued' or (status='running' and lease_until<now()))",
    [attempts],
  );
  const token = randomUUID();
  const { rows } = await pool.query<Job>(
    `with next_job as (select id from market_matching_jobs
    where (status='queued' or (status='running' and lease_until<now())) and next_attempt_at<=now() and attempts<$2 and ($3 or candidate_source<>'lazy')
    order by (candidate_source='revalidation') desc,(candidate_source='lazy'),created_at,id for update skip locked limit 1)
    update market_matching_jobs j set status='running',attempts=j.attempts+1,lease_token=$1,lease_until=now()+interval '90 seconds'
    from next_job n where j.id=n.id returning j.*`,
    [token, attempts, allowLazy],
  );
  return rows[0] ?? null;
}
export async function withTransaction<T>(
  pool: Pool,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const value = await fn(db);
    await db.query("commit");
    return value;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
