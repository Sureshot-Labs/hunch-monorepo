/** Code-owned bind layouts for the two existing action readers, not public SQL
 * parameters. Each hop emits one attempt or one attempt-less step. Single-row
 * indexed probes avoid a steps × attempts intermediate result before LIMIT.
 * Callers hydrate only fact_page and retain their own revision/ownership guard.
 */
export function fundingActionPageCtes(
  scope: "handoff_operation" | "refund_segment",
): string {
  const ordinal = scope === "handoff_operation" ? "$3" : "$4";
  const attempt = scope === "handoff_operation" ? "$4" : "$5";
  const limit = scope === "handoff_operation" ? "$5" : "$3";
  const owner =
    scope === "handoff_operation"
      ? "where exists(select 1 from funding_operations operation_row where operation_row.id=$1::uuid and operation_row.user_id=$2::uuid)"
      : "";
  return `with recursive work_page as (
  select case when resume_step.ordinal=${ordinal}::integer then resume_step.id end as step_id,
    ${ordinal}::integer as step_ordinal,null::uuid as attempt_id,
    ${attempt}::integer as attempt_number,0 as work_count
  from (values (1)) seed(seed_id)
  left join lateral (
    select id,ordinal from funding_operation_steps step_row
    where ${ordinal}::integer>=0 and step_row.operation_id=$1::uuid
      and step_row.ordinal>=${ordinal}::integer
    order by step_row.ordinal limit 1
  ) resume_step on true
  ${owner}
  union all
  select coalesce(next_step.id,previous_row.step_id),
    coalesce(next_step.ordinal,previous_row.step_ordinal),
    coalesce(same_step_attempt.id,first_attempt.id),
    coalesce(same_step_attempt.attempt_number,first_attempt.attempt_number,0),
    previous_row.work_count+1
  from work_page previous_row
  left join lateral (
    select id,attempt_number from funding_operation_step_attempts attempt_row
    where attempt_row.step_id=previous_row.step_id
      and attempt_row.attempt_number>previous_row.attempt_number
    order by attempt_row.attempt_number limit 1
  ) same_step_attempt on true
  left join lateral (
    select id,ordinal from funding_operation_steps step_row
    where same_step_attempt.id is null and step_row.operation_id=$1::uuid
      and step_row.ordinal>previous_row.step_ordinal
    order by step_row.ordinal limit 1
  ) next_step on true
  left join lateral (
    select id,attempt_number from funding_operation_step_attempts attempt_row
    where attempt_row.step_id=next_step.id
    order by attempt_row.attempt_number limit 1
  ) first_attempt on true
  where previous_row.work_count<${limit}::integer
    and (same_step_attempt.id is not null or next_step.id is not null)
), fact_page as materialized (
  select step_id,step_ordinal,attempt_id,attempt_number from work_page where work_count>0
)`;
}
