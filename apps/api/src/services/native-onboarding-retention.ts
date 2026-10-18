import type { DbQuery } from "../db.js";

/** Bounded indexed cleanup also runs while APNs delivery is awaiting activation. */
export async function retainNativeOnboardingData(db: DbQuery) {
  await db.query(`with expired as (select id from native_push_deliveries
    where status in ('pending','sending') and occurred_at<now()-interval '24 hours'
      and (lease_until is null or lease_until<now()) order by occurred_at,id limit 1000 for update skip locked)
    update native_push_deliveries d set status='skipped',error_code='expired',finished_at=now(),lease_id=null,lease_until=null from expired where d.id=expired.id`);
  await db.query(`with expired as (select id from native_push_deliveries
    where status in ('sent','skipped','failed') and finished_at<now()-interval '7 days' order by finished_at,id limit 1000)
    delete from native_push_deliveries d using expired where d.id=expired.id`);
  await db.query(`with expired as (select id from native_push_events where finished and occurred_at<now()-interval '7 days' order by occurred_at,id limit 1000)
    delete from native_push_events e using expired where e.id=expired.id`);
  await db.query(`with expired as (select id from social_trader_ranking_snapshots where created_at<now()-interval '1 hour' order by created_at,id limit 10)
    delete from social_trader_ranking_snapshots s using expired where s.id=expired.id`);
  await db.query(`with expired as (select user_id,topic,subject_key from native_push_topic_cooldowns where occurred_at<now()-interval '30 days' order by occurred_at,user_id limit 1000 for update skip locked)
    delete from native_push_topic_cooldowns c using expired where c.user_id=expired.user_id and c.topic=expired.topic and c.subject_key=expired.subject_key
      and c.occurred_at<now()-interval '30 days'`);
  await db.query(
    `delete from native_push_worker_cursors where name like 'new-markets:%' and cycle_started_at<now()-interval '7 days'`,
  );
}
