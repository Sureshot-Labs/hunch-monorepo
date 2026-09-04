-- Reservations that fence a balance created by an earlier action are not a
-- second economic source. Persist the role so the venue-neutral SQL shape
-- validator can distinguish the fence without inspecting provider metadata.
alter table balance_reservations
  add column economic_role text not null default 'source_input',
  add constraint balance_reservations_economic_role_check
    check (
      economic_role = 'source_input'
      or (
        economic_role = 'future_credit_fence'
        and mode = 'subtract_available'
        and segment_id is null
      )
    );

create or replace function funding_guard_reservation_update()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and old.state in ('consumed', 'released')
    and new.state = old.state;

  if (
    new.operation_id,
    new.component_id,
    new.location_id,
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.raw_amount,
    new.mode,
    new.economic_role,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.component_id,
    old.location_id,
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.raw_amount,
    old.mode,
    old.economic_role,
    old.expires_at,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'funding reservation amount, role, and ownership are immutable'
      using errcode = '23514';
  end if;
  if old.state <> 'active' and new.state is distinct from old.state then
    raise exception 'terminal funding reservation cannot transition'
      using errcode = '23514';
  end if;
  if old.state <> 'active' and (
    new.consumer_kind is distinct from old.consumer_kind
    or new.consumer_ref is distinct from old.consumer_ref
    or new.outcome_reason is distinct from old.outcome_reason
    or new.consumed_at is distinct from old.consumed_at
    or new.released_at is distinct from old.released_at
  ) then
    raise exception 'terminal funding reservation outcome is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Keep SQL responsible for venue-neutral graph and binding invariants. Exact
-- venue actions are validated by a versioned application validator before the
-- immutable plan is inserted; step-state updates remain governed by the
-- funding_operation_steps transition trigger.
create or replace function funding_validate_operation_segment_shape(
  target_operation_id uuid
)
returns void
language plpgsql
as $$
declare
  operation_plan_kind text;
  operation_support_metadata jsonb;
  supports_unbound_preparation_chain boolean;
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
  invalid_unbound_chain_count integer;
  minimum_step_ordinal integer;
  maximum_step_ordinal integer;
  segment_without_step_count integer;
  segment_without_reservation_count integer;
  invalid_observation_binding_count integer;
  invalid_reservation_binding_count integer;
  source_reservation_count integer;
  unbound_source_reservation_count integer;
begin
  select
    operation_row.plan_kind,
    operation_row.support_metadata
  into
    operation_plan_kind,
    operation_support_metadata
  from funding_operations operation_row
  where operation_row.id = target_operation_id;

  if operation_plan_kind is null then
    return;
  end if;

  supports_unbound_preparation_chain := coalesce(
    operation_plan_kind in ('venue_preparation', 'composite_route')
      and jsonb_typeof(operation_support_metadata -> 'planValidation')
        = 'object'
      and nullif(
        operation_support_metadata -> 'planValidation' ->> 'validatorId',
        ''
      ) is not null
      and jsonb_typeof(
        operation_support_metadata -> 'planValidation' -> 'version'
      ) = 'number',
    false
  );

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
        and operation_plan_kind in (
          'wallet_route',
          'composite_route',
          'venue_preparation'
        )
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
            and operation_plan_kind in (
              'wallet_route',
              'composite_route',
              'venue_preparation'
            )
          )
          and not supports_unbound_preparation_chain
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
    raise exception 'unbound funding steps require a preparation-compatible plan kind'
      using errcode = '23514';
  end if;

  -- Preserve the already-deployed wallet-route handoff contract. New
  -- multi-action venue preparation is owned by the application validator.
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
          and (
            (
              supports_unbound_preparation_chain
              and dependent_step.segment_id is null
            )
            or (
              operation_plan_kind in ('wallet_route', 'composite_route')
              and not supports_unbound_preparation_chain
              and dependent_step.segment_id is not null
            )
          )
      )
    );
  if invalid_pre_route_handoff_count <> 0 then
    raise exception 'Polymarket pre-route handoff must directly gate its next exact route step'
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
    and step_count = 1
    and venue_preparation_step_count <> 1 then
    raise exception 'venue preparation plan requires one exact preparation step'
      using errcode = '23514';
  end if;

  if supports_unbound_preparation_chain then
    if unbound_step_count < 1
      or unbound_step_count > 8
      or venue_preparation_step_count <> 1 then
      raise exception 'versioned unbound chain has an invalid generic shape'
        using errcode = '23514';
    end if;

    select count(*)::integer
    into invalid_unbound_chain_count
    from funding_operation_steps funding_step
    where funding_step.operation_id = target_operation_id
      and funding_step.segment_id is null
      and (
        funding_step.ordinal < 0
        or funding_step.ordinal >= unbound_step_count
        or (
          funding_step.ordinal = 0
          and funding_step.depends_on_step_id is not null
        )
        or (
          funding_step.ordinal > 0
          and not exists (
            select 1
            from funding_operation_steps previous_step
            where previous_step.operation_id = funding_step.operation_id
              and previous_step.segment_id is null
              and previous_step.ordinal = funding_step.ordinal - 1
              and funding_step.depends_on_step_id = previous_step.id
          )
        )
        or (
          funding_step.step_kind = 'venue_preparation'
          and funding_step.ordinal <> unbound_step_count - 1
        )
      );
    if invalid_unbound_chain_count <> 0 then
      raise exception 'versioned unbound steps must form one linear preparation chain'
        using errcode = '23514';
    end if;
  elsif operation_plan_kind = 'venue_preparation' and step_count <> 1 then
    raise exception 'multi-step venue preparation requires a versioned plan validator'
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
    if (
      supports_unbound_preparation_chain
      and unbound_step_count < 1
    ) or (
      not supports_unbound_preparation_chain
      and unbound_step_count
        <> venue_preparation_step_count + pre_route_handoff_step_count
    ) then
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
        and economic_role = 'source_input'
    )::integer,
    count(*) filter (
      where mode = 'subtract_available'
        and economic_role = 'source_input'
        and segment_id is null
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
          and funding_reservation.economic_role = 'source_input'
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

