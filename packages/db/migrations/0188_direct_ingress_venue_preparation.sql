-- Direct multi-asset ingress may carry one deferred venue-preparation step.
-- The step stays dormant until the observer verifies the exact accepted asset.
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
  minimum_step_ordinal integer;
  maximum_step_ordinal integer;
  segment_without_step_count integer;
  segment_without_reservation_count integer;
  invalid_observation_binding_count integer;
  invalid_reservation_binding_count integer;
  source_reservation_count integer;
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

  if operation_plan_kind = 'composite_route' then
    if segment_count < 2 then
      raise exception 'composite funding plan requires at least two segments'
        using errcode = '23514';
    end if;
    if relay_segment_count <> segment_count then
      raise exception 'composite funding plan currently supports Relay legs only'
        using errcode = '23514';
    end if;
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
    count(*) filter (where segment_id is null)::integer,
    count(*) filter (where step_kind = 'venue_preparation')::integer,
    min(ordinal)::integer,
    max(ordinal)::integer
  into
    step_count,
    unbound_step_count,
    venue_preparation_step_count,
    minimum_step_ordinal,
    maximum_step_ordinal
  from funding_operation_steps
  where operation_id = target_operation_id;

  if step_count > 0
    and (
      minimum_step_ordinal <> 0
      or maximum_step_ordinal <> step_count - 1
    ) then
    raise exception 'funding steps must have contiguous ordinals from zero'
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) and unbound_step_count <> 0 then
    raise exception 'provider route steps must bind to an exact segment'
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
    'direct_external_handoff'
  )
    and venue_preparation_step_count <> 0 then
    raise exception 'venue preparation step requires a compatible funding plan'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'composite_route' then
    select count(*)::integer
    into segment_without_step_count
    from funding_operation_segments segment
    where segment.operation_id = target_operation_id
      and not exists (
        select 1
        from funding_operation_steps step
        where step.operation_id = segment.operation_id
          and step.segment_id = segment.id
      );
    if segment_without_step_count <> 0 then
      raise exception 'every composite segment requires at least one bound step'
        using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) then
    select count(*)::integer
    into invalid_reservation_binding_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.mode = 'subtract_available'
      and reservation.segment_id is null;
  else
    select count(*)::integer
    into invalid_reservation_binding_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.segment_id is not null;
  end if;
  if invalid_reservation_binding_count <> 0 then
    raise exception 'funding reservation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'venue_preparation' then
    select count(*)::integer
    into source_reservation_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.mode = 'subtract_available';
    if source_reservation_count < 1 then
      raise exception 'venue preparation plan requires reserved exact inputs'
        using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in ('wallet_route', 'composite_route') then
    select count(*)::integer
    into segment_without_reservation_count
    from funding_operation_segments segment
    where segment.operation_id = target_operation_id
      and (
        select count(*)
        from balance_reservations reservation
        where reservation.operation_id = segment.operation_id
          and reservation.segment_id = segment.id
          and reservation.mode = 'subtract_available'
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
    from funding_observations observation
    where observation.operation_id = target_operation_id
      and (
        (
          observation.kind = 'venue_readiness'
          and observation.segment_id is not null
        )
        or (
          observation.kind <> 'venue_readiness'
          and observation.segment_id is null
        )
      );
  else
    select count(*)::integer
    into invalid_observation_binding_count
    from funding_observations observation
    where observation.operation_id = target_operation_id
      and observation.segment_id is not null;
  end if;
  if invalid_observation_binding_count <> 0 then
    raise exception 'funding observation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;
end;
$$;
