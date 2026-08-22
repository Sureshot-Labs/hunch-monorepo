-- A Polymarket Deposit Wallet handoff is an exact user-authorized transfer
-- into the user's controller wallet. It deliberately has an independent
-- action TTL; the downstream Relay action remains bound to its short-lived
-- provider segment. Keep this exception narrow so arbitrary provider actions
-- cannot escape their immutable segment.
create or replace function funding_validate_operation_segment_shape(
  target_operation_id uuid
)
returns void
language plpgsql
as $$
declare
  operation_plan_kind text;
  segment_count integer;
  relay_segment_count integer;
  relay_deposit_segment_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  step_count integer;
  unbound_step_count integer;
  venue_preparation_step_count integer;
  pre_route_handoff_step_count integer;
  invalid_step_binding_count integer;
  invalid_pre_route_handoff_count integer;
  minimum_step_ordinal integer;
  maximum_step_ordinal integer;
  segment_without_step_count integer;
  segment_without_reservation_count integer;
  invalid_observation_binding_count integer;
  invalid_reservation_binding_count integer;
  source_reservation_count integer;
  unbound_source_reservation_count integer;
begin
  select plan_kind
  into operation_plan_kind
  from funding_operations
  where id = target_operation_id;

  if operation_plan_kind is null then
    return;
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where provider_id = 'relay'
    )::integer,
    count(*) filter (
      where provider_id = 'relay' and segment_kind = 'deposit_address'
    )::integer,
    min(ordinal)::integer,
    max(ordinal)::integer
  into
    segment_count,
    relay_segment_count,
    relay_deposit_segment_count,
    minimum_ordinal,
    maximum_ordinal
  from funding_operation_segments
  where operation_id = target_operation_id;

  if operation_plan_kind in ('wallet_route', 'relay_deposit_address')
    and segment_count <> 1 then
    raise exception 'funding plan % requires exactly one segment, found %',
      operation_plan_kind,
      segment_count
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'direct_external_handoff',
    'already_available',
    'venue_preparation'
  )
    and segment_count <> 0 then
    raise exception 'funding plan % requires zero segments, found %',
      operation_plan_kind,
      segment_count
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'composite_route'
    and relay_segment_count <> segment_count then
    raise exception 'composite funding plan supports Relay provider segments only'
      using errcode = '23514';
  end if;

  if segment_count > 0
    and (minimum_ordinal <> 0 or maximum_ordinal <> segment_count - 1) then
    raise exception 'funding segments must have contiguous ordinals from zero'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'relay_deposit_address'
    and relay_deposit_segment_count <> 1 then
    raise exception 'Relay deposit-address plan requires one Relay deposit-address segment'
      using errcode = '23514';
  end if;

  select
    count(*)::integer,
    count(*) filter (where funding_step.segment_id is null)::integer,
    count(*) filter (
      where funding_step.step_kind = 'venue_preparation'
    )::integer,
    count(*) filter (
      where funding_step.segment_id is null
        and funding_step.step_kind = 'external_handoff'
        and funding_step.executor_id = 'polymarket_deposit_wallet_relayer_v1'
        and funding_step.normalized_action ->> 'kind' = 'external_handoff'
        and funding_step.normalized_action ->> 'handoffKind'
          = 'polymarket_deposit_wallet_transfer'
        and funding_step.normalized_action -> 'payload' ->> 'topology'
          = 'deposit_wallet'
        and operation_plan_kind in ('wallet_route', 'composite_route')
    )::integer,
    count(*) filter (
      where
        (funding_step.step_kind = 'venue_preparation'
          and funding_step.segment_id is not null)
        or (
          funding_step.segment_id is null
          and funding_step.step_kind <> 'venue_preparation'
          and not (
            funding_step.step_kind = 'external_handoff'
            and funding_step.executor_id = 'polymarket_deposit_wallet_relayer_v1'
            and funding_step.normalized_action ->> 'kind' = 'external_handoff'
            and funding_step.normalized_action ->> 'handoffKind'
              = 'polymarket_deposit_wallet_transfer'
            and funding_step.normalized_action -> 'payload' ->> 'topology'
              = 'deposit_wallet'
            and operation_plan_kind in ('wallet_route', 'composite_route')
          )
        )
    )::integer,
    min(funding_step.ordinal)::integer,
    max(funding_step.ordinal)::integer
  into
    step_count,
    unbound_step_count,
    venue_preparation_step_count,
    pre_route_handoff_step_count,
    invalid_step_binding_count,
    minimum_step_ordinal,
    maximum_step_ordinal
  from funding_operation_steps funding_step
  where funding_step.operation_id = target_operation_id;

  if step_count > 0
    and (
      minimum_step_ordinal <> 0
      or maximum_step_ordinal <> step_count - 1
    ) then
    raise exception 'funding steps must have contiguous ordinals from zero'
      using errcode = '23514';
  end if;

  if invalid_step_binding_count <> 0 then
    raise exception 'only exact venue preparation or Polymarket pre-route handoff steps may be unbound'
      using errcode = '23514';
  end if;

  select count(*)::integer
  into invalid_pre_route_handoff_count
  from funding_operation_steps pre_route_step
  where pre_route_step.operation_id = target_operation_id
    and pre_route_step.segment_id is null
    and pre_route_step.step_kind = 'external_handoff'
    and pre_route_step.executor_id = 'polymarket_deposit_wallet_relayer_v1'
    and pre_route_step.normalized_action ->> 'kind' = 'external_handoff'
    and pre_route_step.normalized_action ->> 'handoffKind'
      = 'polymarket_deposit_wallet_transfer'
    and pre_route_step.normalized_action -> 'payload' ->> 'topology'
      = 'deposit_wallet'
    and (
      pre_route_step.depends_on_step_id is not null
      or not exists (
        select 1
        from funding_operation_steps dependent_step
        where dependent_step.operation_id = pre_route_step.operation_id
          and dependent_step.depends_on_step_id = pre_route_step.id
          and dependent_step.segment_id is not null
      )
    );
  if invalid_pre_route_handoff_count <> 0 then
    raise exception 'Polymarket pre-route handoff must directly gate a segment-bound provider step'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'wallet_route'
    and (
      unbound_step_count <> pre_route_handoff_step_count
      or pre_route_handoff_step_count > 1
    ) then
    raise exception 'wallet route supports at most one exact unbound pre-route handoff'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'relay_deposit_address'
    and unbound_step_count <> 0 then
    raise exception 'Relay deposit-address steps must bind to an exact segment'
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'direct_external_handoff',
    'already_available',
    'venue_preparation'
  ) and unbound_step_count <> step_count then
    raise exception 'zero-provider plan cannot bind a step to a segment'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'venue_preparation'
    and (step_count <> 1 or venue_preparation_step_count <> 1) then
    raise exception 'venue preparation plan requires one exact preparation step'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'direct_external_handoff'
    and (
      step_count > 1
      or venue_preparation_step_count <> step_count
    ) then
    raise exception 'direct external handoff supports at most one deferred venue preparation step'
      using errcode = '23514';
  end if;

  if operation_plan_kind not in (
    'venue_preparation',
    'direct_external_handoff',
    'composite_route'
  )
    and venue_preparation_step_count <> 0 then
    raise exception 'venue preparation step requires a compatible funding plan'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'composite_route' then
    if venue_preparation_step_count > 1 then
      raise exception 'composite funding plan supports one venue preparation contributor'
        using errcode = '23514';
    end if;
    if segment_count + venue_preparation_step_count < 2 then
      raise exception 'composite funding plan requires at least two contributors'
        using errcode = '23514';
    end if;
    if unbound_step_count
      <> venue_preparation_step_count + pre_route_handoff_step_count then
      raise exception 'composite unbound steps must be exact preparation or pre-route handoff steps'
        using errcode = '23514';
    end if;

    select count(*)::integer
    into segment_without_step_count
    from funding_operation_segments funding_segment
    where funding_segment.operation_id = target_operation_id
      and not exists (
        select 1
        from funding_operation_steps funding_step
        where funding_step.operation_id = funding_segment.operation_id
          and funding_step.segment_id = funding_segment.id
      );
    if segment_without_step_count <> 0 then
      raise exception 'every composite provider segment requires a bound step'
        using errcode = '23514';
    end if;
  end if;

  select
    count(*) filter (
      where mode = 'subtract_available'
    )::integer,
    count(*) filter (
      where mode = 'subtract_available' and segment_id is null
    )::integer
  into source_reservation_count, unbound_source_reservation_count
  from balance_reservations
  where operation_id = target_operation_id;

  if operation_plan_kind in ('wallet_route', 'relay_deposit_address') then
    invalid_reservation_binding_count := unbound_source_reservation_count;
  elsif operation_plan_kind = 'composite_route' then
    invalid_reservation_binding_count :=
      case
        when venue_preparation_step_count = 0
          then unbound_source_reservation_count
        when unbound_source_reservation_count = 0
          then 1
        else 0
      end;
  else
    select count(*)::integer
    into invalid_reservation_binding_count
    from balance_reservations funding_reservation
    where funding_reservation.operation_id = target_operation_id
      and funding_reservation.segment_id is not null;
  end if;
  if invalid_reservation_binding_count <> 0 then
    raise exception 'funding reservation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'venue_preparation'
    and source_reservation_count < 1 then
    raise exception 'venue preparation plan requires reserved exact inputs'
      using errcode = '23514';
  end if;

  if operation_plan_kind in ('wallet_route', 'composite_route') then
    select count(*)::integer
    into segment_without_reservation_count
    from funding_operation_segments funding_segment
    where funding_segment.operation_id = target_operation_id
      and (
        select count(*)
        from balance_reservations funding_reservation
        where funding_reservation.operation_id = funding_segment.operation_id
          and funding_reservation.segment_id = funding_segment.id
          and funding_reservation.mode = 'subtract_available'
      ) <> 1;
    if segment_without_reservation_count <> 0 then
      raise exception 'each wallet-route segment requires one source reservation'
        using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) then
    select count(*)::integer
    into invalid_observation_binding_count
    from funding_observations funding_observation
    where funding_observation.operation_id = target_operation_id
      and (
        (
          funding_observation.kind = 'venue_readiness'
          and (
            funding_observation.segment_id is not null
            or (
              operation_plan_kind = 'composite_route'
              and venue_preparation_step_count = 0
            )
          )
        )
        or (
          funding_observation.kind <> 'venue_readiness'
          and funding_observation.segment_id is null
        )
      );
  else
    select count(*)::integer
    into invalid_observation_binding_count
    from funding_observations funding_observation
    where funding_observation.operation_id = target_operation_id
      and funding_observation.segment_id is not null;
  end if;
  if invalid_observation_binding_count <> 0 then
    raise exception 'funding observation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;
end;
$$;
