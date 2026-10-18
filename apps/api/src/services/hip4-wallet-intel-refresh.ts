// Existing wallet-intel scheduler adapter, not an owned-account observer or
// execution worker. Provider I/O never occurs inside a database transaction.
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  hip4ReadMarketSchema,
  hip4SpotMetadataSchema,
  parseHip4Coin,
  hip4BackgroundRequestWeightLimit,
  hip4BackgroundRepairWeightLimit,
  type Hip4ReadMarket,
} from "@hunch/shared";
import {
  createHip4AccountClient,
  createHip4ReadClient,
  Hip4ReadError,
  type Hip4AccountInfoRequest,
} from "./hip4-client.js";
import { admitHip4Request, readHip4Policy } from "./hip4-repository.js";
import { readHip4AccountPolicy } from "./hip4-account-repository.js";
import {
  planHip4FillRepair,
  advanceHip4FillRepair,
  hip4FillPageSchema,
} from "./hip4-account-history.js";
import { hip4AccountRoleSchema } from "./hip4-account-contract.js";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  projectHip4KnownWalletIntel,
  type Hip4TrackedEndpointObservation,
  type Hip4TrackedFillActivity,
} from "./hip4-wallet-intel.js";
import { multiplyUnsignedDecimals } from "../account-value/decimal.js";
import {
  planHip4TrackedActivityBatch,
  type Hip4TrackedActivityObservation,
} from "./hip4-wallet-intel-recheck.js";
import type { WalletIntelRefreshPolicy } from "./runtime-policies.js";

type Queryable = Pick<PoolClient, "query">;
export type Hip4KnownWalletRefreshPolicy = Pick<
  WalletIntelRefreshPolicy,
  | "followedWalletLimit"
  | "autoTrackedWalletEnabled"
  | "autoTrackedWalletLimit"
  | "autoTrackedSubjectTtlDays"
  | "autoTrackedWalletAttemptBackoffMinutes"
  | "autoTrackedWalletRefreshHours"
  | "snapshotHours"
>;
export const HIP4_ACTIVITY_SCHEMA_READY_SQL = `select
  (select count(*)=2 from pg_index activity_index
    where activity_index.indexrelid in(to_regclass('uq_wae_legacy_event'),to_regclass('uq_wae_source_event'))
      and activity_index.indrelid='wallet_activity_events'::regclass
      and activity_index.indisvalid and activity_index.indisready and activity_index.indisunique)
  and not exists(select 1 from pg_constraint activity_constraint
    where activity_constraint.conrelid='wallet_activity_events'::regclass
      and activity_constraint.conname='uq_wae_wallet_venue_market_side_type_occurred') as ready`;

/** The page is materialized before eligibility/backoff checks. The unconditional
 * lower(address)>cursor bound also works under PostgreSQL's generic plans. */
export const HIP4_KNOWN_WALLET_SOURCE_SQL = `with source_page as materialized (
  select id,address,chain from wallets where chain=$1 and chain<>'solana'
    and lower(address)>$2 order by lower(address) limit $3
) select source_row.id::text as wallet_id,source_row.address,
  coalesce(follow_presence.is_followed,false) as followed,
  coalesce(subject_presence.is_tracked,false) as tracked,
  venue_row.metadata,venue_row.updated_at as attempted_at
  from source_page source_row
  left join lateral (
    select true as is_followed from wallet_follows follow_row
    where follow_row.wallet_id=source_row.id limit 1 offset 0
  ) follow_presence on true
  left join lateral (
    select true as is_tracked from wallet_tracking_subjects subject_row
    where subject_row.wallet_id=source_row.id and subject_row.venue='hyperliquid'
      and subject_row.status='active' and ($5::int<=0 or subject_row.last_selected_at>=$4::timestamptz-$5*interval '1 day')
    limit 1 offset 0
  ) subject_presence on true
  left join lateral (
    select native_venue.metadata,native_venue.updated_at from wallet_venues native_venue
    where native_venue.wallet_id=source_row.id and native_venue.venue='hyperliquid'
    limit 1 offset 0
  ) venue_row on true
  order by lower(source_row.address)`;

const nativeMismatchSql = `(retained_event.metadata->>'nativeFingerprint' is distinct from excluded.metadata->>'nativeFingerprint'
  or (retained_event.metadata->'nativeFill')-'sizeUsd'-'quoteToken' is distinct from (excluded.metadata->'nativeFill')-'sizeUsd'-'quoteToken'
  or retained_event.market_id is distinct from excluded.market_id
  or retained_event.outcome_side is distinct from excluded.outcome_side
  or retained_event.action is distinct from excluded.action
  or retained_event.delta_shares is distinct from excluded.delta_shares
  or retained_event.price is distinct from excluded.price
  or retained_event.occurred_at is distinct from excluded.occurred_at
  or $13::boolean)`;
const retainedRecheckSql = "retained_event.metadata->'nativeRecheck'";
const stickyDisputeSql = `(${retainedRecheckSql}->>'state'='disputed' and (
  ${retainedRecheckSql}->>'observationId'=$11
  or ${retainedRecheckSql}->>'conflictObservationId'=$11
  or case when jsonb_typeof(${retainedRecheckSql}->'conflictAtMs')='number'
    then $12::numeric<=(${retainedRecheckSql}->>'conflictAtMs')::numeric else false end))`;
const clockMsSql = "floor(extract(epoch from clock_timestamp())*1000)::bigint";

/** One atomic indexed row lock compares the retained financial facts and current
 * proof. A read started before a concurrent dispute cannot clear it. Only the
 * proof changes; the original fill, fingerprint and financial columns do not. */
export const HIP4_TRACKED_ACTIVITY_UPSERT_SQL = `insert into wallet_activity_events as retained_event
    (wallet_id,venue,market_id,outcome_side,action,delta_shares,size_usd,price,
      activity_type,source,source_event_key,metadata,occurred_at)
    values($1,'hyperliquid',$2,$3,$4,$5,$6,$7,'trade','hyperliquid_user_fills',$8,
      jsonb_set($9::jsonb,'{nativeRecheck}',jsonb_build_object(
        'version',1,'provenance','fresh_official_user_fills','state',case when $13::boolean then 'disputed' else 'verified' end,
        'sourceEventKey',$8::text,'retainedFingerprint',$9::jsonb->>'nativeFingerprint',
        'lastObservedFingerprint',coalesce($14::text,$9::jsonb->>'nativeFingerprint'),
        'observationId',$11::text,'observationStartedAtMs',$12::bigint,
        'conflictObservationId',case when $13::boolean then $11::text else null end,
        'conflictAtMs',case when $13::boolean then ${clockMsSql} else null end,
        'checkedAtMs',${clockMsSql}),true),$10)
    on conflict(wallet_id,venue,source,source_event_key) where source_event_key is not null
    do update set metadata=jsonb_set(coalesce(retained_event.metadata,'{}'::jsonb),'{nativeRecheck}',jsonb_build_object(
      'version',1,'provenance','fresh_official_user_fills','state',case when ${nativeMismatchSql} or ${stickyDisputeSql} then 'disputed' else 'verified' end,
      'sourceEventKey',retained_event.source_event_key,
      'retainedFingerprint',retained_event.metadata->>'nativeFingerprint',
      'lastObservedFingerprint',coalesce($14::text,excluded.metadata->>'nativeFingerprint'),
      'observationId',$11::text,'observationStartedAtMs',$12::bigint,
      'conflictObservationId',case when ${nativeMismatchSql} then $11::text else ${retainedRecheckSql}->>'conflictObservationId' end,
      'conflictAtMs',case when ${nativeMismatchSql} then to_jsonb(${clockMsSql}) else ${retainedRecheckSql}->'conflictAtMs' end,
      'checkedAtMs',${clockMsSql}),true)
    returning id,metadata#>>'{nativeRecheck,state}'='disputed' as conflict`;

// Convert only an old wallet-wide diagnostic to durable legacy ambiguity. New
// conflicts have exact event proof and must not quarantine unrelated rows.
export const HIP4_KNOWN_WALLET_METADATA_SQL = `update wallet_venues set
  metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{hip4Intel}',
    $2::jsonb||jsonb_build_object('legacyActivityAmbiguity',
      coalesce(metadata#>>'{hip4Intel,legacyActivityAmbiguity}'='true',false)
      or (coalesce(metadata#>>'{hip4Intel,activityPersistence}'='conflicting_fill_identity',false)
        and metadata#>>'{hip4Intel,activityConflictVersion}' is distinct from '1')),true),
  updated_at=$3 where wallet_id=$1 and venue='hyperliquid'`;

export async function persistHip4TrackedActivity(
  db: Queryable,
  walletId: string,
  activity: Hip4TrackedFillActivity,
  observation: Hip4TrackedActivityObservation,
) {
  if (
    observation.provenance !== "fresh_official_user_fills" ||
    !observation.observationId ||
    !Number.isSafeInteger(observation.observationStartedAtMs)
  )
    throw new Error("fresh_native_activity_observation_required");
  const fingerprint = hip4TrackedFillFingerprint(activity);
  const inserted = await db.query(HIP4_TRACKED_ACTIVITY_UPSERT_SQL, [
    walletId,
    activity.marketId,
    activity.outcomeSide,
    activity.action,
    activity.deltaShares,
    activity.sizeUsd,
    activity.price,
    activity.sourceEventKey,
    JSON.stringify({
      source: "hyperliquid_user_fills",
      scope: "known_wallet_only",
      nativeFingerprint: fingerprint,
      nativeFill: activity,
      completeHistory: false,
      costBasis: "unknown",
      globalHolderCoverage: "unavailable",
    }),
    activity.occurredAt,
    observation.observationId,
    observation.observationStartedAtMs,
    !!observation.conflictingFingerprint,
    observation.conflictingFingerprint ?? null,
  ]);
  const conflict = inserted.rows[0]?.conflict === true;
  return { saved: !!inserted.rowCount && !conflict, conflict };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const validTime = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
const sourceMarketIds = (values: unknown[]) => [
  ...new Set(
    values.flatMap((value) => {
      const coin = record(value).coin;
      if (typeof coin !== "string" || !/^[#+]/.test(coin)) return [];
      try {
        return [parseHip4Coin(coin.replace(/^\+/, "#")).outcome];
      } catch {
        return [];
      }
    }),
  ),
];

export async function collectHip4KnownWalletIntel(input: {
  pool: Pool;
  client: PoolClient;
  policy: Hip4KnownWalletRefreshPolicy;
  snapshotAt: Date;
  fetcher?: typeof fetch;
}) {
  const { pool, client, policy, snapshotAt } = input;
  const result = {
    selected: 0,
    attempted: 0,
    snapshotRows: 0,
    activityRows: 0,
    fillConflicts: 0,
    budgetExhausted: 0,
    errors: 0,
    skipped: 0,
    activitySchemaReady: false,
  };
  const read = await readHip4Policy(pool, "discovery");
  if (!read.policy.enabled || read.lifecycle.indexerMode !== "full")
    return result;
  const pageSize =
    policy.followedWalletLimit +
    (policy.autoTrackedWalletEnabled ? policy.autoTrackedWalletLimit : 0);
  if (pageSize <= 0) return result;
  const environment = read.policy.environment;
  const chain = `hypercore:${environment}`;
  const stateKey = `hip4_known_wallets:${environment}`;
  const lockName = `hip4-known-wallets:${environment}`;
  const lock = await client.query(
    "select pg_try_advisory_lock(hashtextextended($1,0)) as acquired",
    [lockName],
  );
  if (!lock.rows[0]?.acquired) return { ...result, skipped: 1 };
  try {
    // Schema readiness gates only native activity, not current account facts.
    try {
      result.activitySchemaReady = !!(
        await client.query(HIP4_ACTIVITY_SCHEMA_READY_SQL)
      ).rows[0]?.ready;
    } catch {
      result.activitySchemaReady = false;
    }
    await client.query(
      "insert into unified_refresh_pipeline_state(pipeline_name) values($1) on conflict do nothing",
      [stateKey],
    );
    const saved = record(
      (
        await client.query(
          "select source_cursor from unified_refresh_pipeline_state where pipeline_name=$1",
          [stateKey],
        )
      ).rows[0]?.source_cursor,
    );
    const after =
      typeof saved.lastAddress === "string" &&
      /^0x[0-9a-f]{40}$/.test(saved.lastAddress)
        ? saved.lastAddress
        : "";
    const source = await client.query<{
      wallet_id: string;
      address: string;
      followed: boolean;
      tracked: boolean;
      metadata: unknown;
      attempted_at: Date | null;
    }>(HIP4_KNOWN_WALLET_SOURCE_SQL, [
      chain,
      after,
      pageSize,
      snapshotAt,
      policy.autoTrackedSubjectTtlDays,
    ]);
    result.selected = source.rows.length;
    if (!source.rows.length) {
      await client.query(
        "update unified_refresh_pipeline_state set source_cursor='{}'::jsonb,updated_at=now() where pipeline_name=$1",
        [stateKey],
      );
      return result;
    }
    const accountPolicy = (await readHip4AccountPolicy(pool)).policy;
    let exhausted = false;
    const admit = async (weight: number) => {
      const current = await readHip4Policy(pool, "discovery");
      if (
        !current.policy.enabled ||
        current.lifecycle.indexerMode !== "full" ||
        current.policy.environment !== environment
      )
        throw new Error("known_wallet_reads_disabled");
      return admitHip4Request(
        pool,
        environment,
        weight,
        current.policy.requestWeightPerMinute,
        {
          scope: "background_repair",
          maximum: hip4BackgroundRepairWeightLimit(current.policy),
          backgroundMaximum: hip4BackgroundRequestWeightLimit(current.policy),
        },
      );
    };
    const accountRead = createHip4AccountClient(
      read.policy,
      admit,
      input.fetcher,
    );
    const publicRead = createHip4ReadClient(read.policy, admit, input.fetcher);
    let quote: { tokenId: string; index: number; weiDecimals: number } | null =
      null;
    let followed = 0,
      tracked = 0;
    const advance = async (address: string) =>
      client.query(
        "update unified_refresh_pipeline_state set source_cursor=$2::jsonb,updated_at=now() where pipeline_name=$1",
        [stateKey, JSON.stringify({ lastAddress: address.toLowerCase() })],
      );
    for (const subject of source.rows) {
      const previous = record(record(subject.metadata).hip4Intel);
      const attemptedAt = subject.attempted_at?.getTime() ?? 0;
      const freshAt = validTime(previous.lastCompletePositionsAt);
      const refreshHours = subject.followed
        ? policy.snapshotHours
        : policy.autoTrackedWalletRefreshHours;
      const eligible =
        (subject.followed && followed < policy.followedWalletLimit) ||
        (policy.autoTrackedWalletEnabled &&
          subject.tracked &&
          tracked < policy.autoTrackedWalletLimit);
      if (
        !eligible ||
        attemptedAt >
          snapshotAt.getTime() -
            policy.autoTrackedWalletAttemptBackoffMinutes * 60000 ||
        (freshAt &&
          Date.parse(freshAt) > snapshotAt.getTime() - refreshHours * 3600000)
      ) {
        result.skipped++;
        await advance(subject.address);
        continue;
      }
      if (exhausted) break;
      const identity = hip4WalletIntelIdentity(environment, subject.address);
      const activityObservation = {
        provenance: "fresh_official_user_fills" as const,
        observationId: randomUUID(),
        observationStartedAtMs: Date.now(),
      };
      if (!quote) {
        try {
          const metadata = hip4SpotMetadataSchema.parse(
            await publicRead({ type: "spotMeta" }),
          );
          const native = metadata.tokens.find(
            (token) =>
              token.name === "USDC" &&
              token.index === 0 &&
              token.weiDecimals === 8,
          );
          if (!native?.tokenId) throw new Error("unknown_quote_identity");
          quote = {
            tokenId: native.tokenId,
            index: native.index,
            weiDecimals: native.weiDecimals,
          };
        } catch (error) {
          result.errors++;
          result.budgetExhausted += Number(
            error instanceof Hip4ReadError &&
              error.reason === "budget_exhausted",
          );
          break;
        }
      }
      result.attempted++;
      if (subject.followed) followed++;
      else tracked++;
      await client.query(
        `insert into wallet_venues(wallet_id,venue,metadata,updated_at) values($1,'hyperliquid','{}'::jsonb,$2)
        on conflict(wallet_id,venue) do update set updated_at=excluded.updated_at`,
        [subject.wallet_id, snapshotAt],
      );
      const observe = async (
        request: Hip4AccountInfoRequest,
      ): Promise<Hip4TrackedEndpointObservation> => {
        if (exhausted)
          return {
            available: false,
            attemptedAt: snapshotAt.toISOString(),
            reason: "budget_exhausted",
          };
        try {
          const value = await accountRead(request);
          return {
            available: true,
            observedAt: new Date().toISOString(),
            value,
          };
        } catch (error) {
          const reason =
            error instanceof Hip4ReadError ? error.reason : "invalid_response";
          if (reason === "budget_exhausted") {
            exhausted = true;
            result.budgetExhausted++;
          }
          return {
            available: false,
            attemptedAt: new Date().toISOString(),
            reason,
          };
        }
      };
      const role = await observe({ type: "userRole", user: identity.address });
      const roleValue = role.available ? role.value : null;
      const supported = hip4AccountRoleSchema.safeParse(roleValue);
      const usable =
        supported.success && ["user", "missing"].includes(supported.data.role);
      const unavailable: Hip4TrackedEndpointObservation = {
        available: false,
        attemptedAt: new Date().toISOString(),
        reason: "unsupported_account_role",
      };
      const mode = usable
        ? await observe({ type: "userAbstraction", user: identity.address })
        : unavailable;
      const positions = usable
        ? await observe({
            type: "spotClearinghouseState",
            user: identity.address,
          })
        : unavailable;
      const orders = usable
        ? await observe({ type: "frontendOpenOrders", user: identity.address })
        : unavailable;
      const noActivity: Hip4TrackedEndpointObservation = {
        available: false,
        attemptedAt: new Date().toISOString(),
        reason: "activity_schema_pending_index_repair",
      };
      const fills =
        usable && result.activitySchemaReady
          ? await observe({
              type: "userFills",
              user: identity.address,
              aggregateByTime: false,
            })
          : result.activitySchemaReady
            ? unavailable
            : noActivity;
      const markets = new Map<string, Hip4ReadMarket>();
      const loadMarkets = async (values: unknown[]) => {
        const outcomes = sourceMarketIds(values);
        if (!outcomes.length) return;
        const found = await client.query(
          "select read_model from hip4_read_markets where environment=$1 and outcome=any($2::bigint[])",
          [environment, outcomes],
        );
        for (const row of found.rows) {
          const parsed = hip4ReadMarketSchema.safeParse(row.read_model);
          if (parsed.success) markets.set(parsed.data.marketId, parsed.data);
        }
      };
      await loadMarkets([
        ...(Array.isArray(
          record(positions.available ? positions.value : null).balances,
        )
          ? (record(positions.available ? positions.value : null)
              .balances as unknown[])
          : []),
        ...(fills.available && Array.isArray(fills.value) ? fills.value : []),
      ]);
      const projectionInput = {
        identity,
        role: roleValue,
        abstraction: mode.available ? mode.value : null,
        roleFailure: !role.available ? role.reason : undefined,
        abstractionFailure: !mode.available ? mode.reason : undefined,
        quote,
        positions,
        openOrders: orders,
        fills,
        quoteTokensByMarket: new Map(
          [...markets].flatMap(([id, market]) =>
            market.quoteToken ? [[id, market.quoteToken] as const] : [],
          ),
        ),
      };
      const projected = projectHip4KnownWalletIntel(projectionInput);
      const positionObservedAt =
        projected.coverage.positions.observedAt ?? new Date().toISOString();
      const activities = [...projected.activityObservations];
      let repair = planHip4FillRepair(
        previous.fillRepair,
        accountPolicy.historyLookbackMs,
        Date.now(),
        accountPolicy.historyRepairMaxGapDetails,
      );
      const repairCheckpoint = structuredClone(repair);
      if (usable && result.activitySchemaReady && !exhausted) {
        for (
          let page = 0;
          page < accountPolicy.historyRepairPagesPerRefresh &&
          repair.nextTime !== null;
          page++
        ) {
          const observed = await observe({
            type: "userFillsByTime",
            user: identity.address,
            startTime: repair.nextTime,
            endTime: repair.endTime,
            aggregateByTime: false,
          });
          if (!observed.available) {
            repair = {
              ...repair,
              lastAttemptAt: new Date().toISOString(),
              lastError: observed.reason,
            };
            break;
          }
          try {
            const rows = hip4FillPageSchema.parse(observed.value);
            await loadMarkets(rows);
            const history = projectHip4KnownWalletIntel({
              ...projectionInput,
              fills: observed,
              quoteTokensByMarket: new Map(
                [...markets].flatMap(([id, market]) =>
                  market.quoteToken ? [[id, market.quoteToken] as const] : [],
                ),
              ),
            });
            activities.push(...history.activityObservations);
            if (
              history.coverage.fills.invalidRows ||
              history.coverage.fills.conflictingIdentities
            )
              throw new Error("invalid_fill_page");
            repair = advanceHip4FillRepair(
              repair,
              rows,
              observed.observedAt,
              accountPolicy.historyRepairMaxGapDetails,
            );
          } catch {
            repair = {
              ...repair,
              lastAttemptAt: new Date().toISOString(),
              lastError: "invalid_fill_page",
            };
            break;
          }
        }
      }
      // No provider calls below this point. Snapshot/fill/cursor publication is
      // atomic; retries cannot mark uncaptured history covered.
      await client.query("begin");
      try {
        let conflicts = 0;
        for (const planned of planHip4TrackedActivityBatch(activities)) {
          const savedActivity = await persistHip4TrackedActivity(
            client,
            subject.wallet_id,
            planned.activity,
            {
              ...activityObservation,
              conflictingFingerprint: planned.conflictingFingerprint,
            },
          );
          if (savedActivity.conflict) conflicts++;
          else result.activityRows++;
        }
        result.fillConflicts += conflicts;
        if (conflicts)
          repair = {
            ...repairCheckpoint,
            lastAttemptAt: new Date().toISOString(),
            lastError: "conflicting_fill_identity",
          };
        if (projected.canReplacePreviousPositions) {
          const rows = projected.positions.map((position) => ({
            marketId: position.marketId,
            tokenId: position.tokenId,
            outcomeSide: position.sideIndex === 0 ? "YES" : "NO",
            shares: position.quantity,
          }));
          const priorAt = validTime(previous.lastCompletePositionsAt);
          if (priorAt) {
            const prior = await client.query(
              "select market_id,outcome_side,metadata->>'tokenId' as token_id from wallet_position_snapshots where wallet_id=$1 and venue='hyperliquid' and snapshot_at=$2 and shares>0",
              [subject.wallet_id, priorAt],
            );
            for (const row of prior.rows)
              if (
                !rows.some(
                  (current) =>
                    current.marketId === row.market_id &&
                    current.outcomeSide === row.outcome_side,
                )
              )
                rows.push({
                  marketId: row.market_id,
                  tokenId: row.token_id,
                  outcomeSide: row.outcome_side,
                  shares: "0",
                });
          }
          for (const row of rows) {
            const market = markets.get(row.marketId);
            const side = market?.sides.find(
              (side) => side.tokenId === row.tokenId,
            );
            const price =
              market?.quoteToken === "USDC" &&
              side?.bookState === "fresh" &&
              side.bookAt &&
              Date.parse(side.bookAt) <= Date.now() &&
              Date.now() - Date.parse(side.bookAt) <= read.policy.bookMaxAgeMs
                ? side.bid
                : null;
            await client.query(
              `insert into wallet_position_snapshots(wallet_id,venue,market_id,outcome_side,shares,size_usd,price,metadata,snapshot_at)
              values($1,'hyperliquid',$2,$3,$4,$5,$6,$7::jsonb,$8)
              on conflict(wallet_id,venue,market_id,outcome_side,snapshot_at) do nothing`,
              [
                subject.wallet_id,
                row.marketId,
                row.outcomeSide,
                row.shares,
                price ? multiplyUnsignedDecimals(row.shares, price) : null,
                price,
                JSON.stringify({
                  source: "hip4_known_wallet",
                  tokenId: row.tokenId,
                  coverage: projected.coverage,
                  costBasis: "unknown",
                }),
                positionObservedAt,
              ],
            );
            result.snapshotRows++;
          }
        }
        const metadata = {
          coverage: projected.coverage,
          openOrders:
            projected.coverage.openOrders.status === "available"
              ? projected.openOrders
              : (previous.openOrders ?? []),
          openOrdersObservedAt:
            projected.coverage.openOrders.status === "available"
              ? projected.coverage.openOrders.observedAt
              : (previous.openOrdersObservedAt ?? null),
          partialPositions: projected.canReplacePreviousPositions
            ? []
            : projected.positions,
          lastCompletePositionsAt: projected.canReplacePreviousPositions
            ? positionObservedAt
            : (previous.lastCompletePositionsAt ?? null),
          fillRepair: repair,
          activityConflictVersion: 1,
          activityPersistence: result.activitySchemaReady
            ? conflicts
              ? "conflicting_fill_identity"
              : "available"
            : "activity_schema_pending_index_repair",
        };
        await client.query(HIP4_KNOWN_WALLET_METADATA_SQL, [
          subject.wallet_id,
          JSON.stringify(metadata),
          snapshotAt,
        ]);
        await client.query(
          "update wallet_tracking_subjects set last_refresh_attempted_at=$2,last_refreshed_at=case when $3 then $2 else last_refreshed_at end where wallet_id=$1 and venue='hyperliquid' and status='active'",
          [
            subject.wallet_id,
            snapshotAt,
            projected.canReplacePreviousPositions,
          ],
        );
        await advance(subject.address);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [
      lockName,
    ]);
  }
}
