-- Keep provider-owned handoff prefixes separate from versioned preparation chains.
-- Replace the validator only: no historical operation scan or mutation at deploy.
-- Tagged composites must prove exact contributor, segment and dependency ownership
-- before a provider handoff is excluded from the preparation-local chain.
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
  preparation_source_leg_id text;
  provider_handoff_step_ids uuid[] := array[]::uuid[];
  preparation_local_step_count integer;
  invalid_contributor_step_count integer;
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
        and funding_is_owned_controller_handoff(funding_step.executor_id, funding_step.normalized_action)
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
            and funding_is_owned_controller_handoff(funding_step.executor_id, funding_step.normalized_action)
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

  -- Untagged historical plans retain the deployed contract. New composites
  -- identify the preparation owner with the venue_preparation step's leg tag;
  -- a null segment alone does not identify a preparation action.
  if supports_unbound_preparation_chain
    and operation_plan_kind = 'composite_route' then
    select funding_step.action_validation_result ->> 'compositeSourceLegId'
    into preparation_source_leg_id
    from funding_operation_steps funding_step
    where funding_step.operation_id = target_operation_id
      and funding_step.step_kind = 'venue_preparation'
    order by funding_step.ordinal
    limit 1;

    if preparation_source_leg_id is not null then
      select count(*)::integer
      into invalid_contributor_step_count
      from funding_operation_steps funding_step
      left join funding_operation_steps parent_step
        on parent_step.id = funding_step.depends_on_step_id
        and parent_step.operation_id = funding_step.operation_id
      where funding_step.operation_id = target_operation_id
        and not coalesce(
          jsonb_typeof(funding_step.action_validation_result -> 'compositeSourceLegId') = 'string'
          and nullif(funding_step.action_validation_result ->> 'compositeSourceLegId', '') is not null
          and (
            funding_step.depends_on_step_id is null
            or (
              parent_step.ordinal < funding_step.ordinal
              and parent_step.action_validation_result ->> 'compositeSourceLegId'
                = funding_step.action_validation_result ->> 'compositeSourceLegId'
            )
          )
          and (
            (
              funding_step.action_validation_result ->> 'compositeSourceLegId'
                = preparation_source_leg_id
              and funding_step.segment_id is null
              and funding_step.action_validation_result -> 'compositeSegmentOrdinal' = 'null'::jsonb
            )
            or (
              funding_step.action_validation_result ->> 'compositeSourceLegId'
                <> preparation_source_leg_id
              and funding_step.step_kind <> 'venue_preparation'
              and exists (
                select 1
                from funding_operation_segments provider_segment
                where provider_segment.operation_id = funding_step.operation_id
                  and to_jsonb(provider_segment.ordinal)
                    = funding_step.action_validation_result -> 'compositeSegmentOrdinal'
                  and (
                    funding_step.segment_id = provider_segment.id
                    or (
                      funding_step.segment_id is null
                      and funding_step.step_kind = 'external_handoff'
                      and funding_is_owned_controller_handoff(
                        funding_step.executor_id, funding_step.normalized_action
                      )
                      -- Provider prefixes remain independent roots and must
                      -- directly gate their own exact provider segment.
                      and funding_step.depends_on_step_id is null
                      and exists (
                        select 1
                        from funding_operation_steps dependent_step
                        where dependent_step.operation_id = funding_step.operation_id
                          and dependent_step.depends_on_step_id = funding_step.id
                          and dependent_step.segment_id = provider_segment.id
                          and dependent_step.action_validation_result ->> 'compositeSourceLegId'
                            = funding_step.action_validation_result ->> 'compositeSourceLegId'
                      )
                    )
                  )
              )
              and not exists (
                select 1
                from funding_operation_steps other_provider_step
                where other_provider_step.operation_id = funding_step.operation_id
                  and other_provider_step.action_validation_result ->> 'compositeSourceLegId'
                    <> preparation_source_leg_id
                  and (
                    (
                      other_provider_step.action_validation_result ->> 'compositeSourceLegId'
                        = funding_step.action_validation_result ->> 'compositeSourceLegId'
                      and other_provider_step.action_validation_result -> 'compositeSegmentOrdinal'
                        is distinct from funding_step.action_validation_result -> 'compositeSegmentOrdinal'
                    )
                    or (
                      other_provider_step.action_validation_result ->> 'compositeSourceLegId'
                        <> funding_step.action_validation_result ->> 'compositeSourceLegId'
                      and other_provider_step.action_validation_result -> 'compositeSegmentOrdinal'
                        = funding_step.action_validation_result -> 'compositeSegmentOrdinal'
                    )
                  )
              )
            )
          ),
          false
        );
      if invalid_contributor_step_count <> 0 then
        raise exception 'versioned composite steps require exact contributor and provider dependency ownership'
          using errcode = '23514';
      end if;

      select coalesce(array_agg(funding_step.id), array[]::uuid[])
      into provider_handoff_step_ids
      from funding_operation_steps funding_step
      where funding_step.operation_id = target_operation_id
        and funding_step.segment_id is null
        and funding_step.action_validation_result ->> 'compositeSourceLegId'
          <> preparation_source_leg_id;
    end if;
  end if;

  preparation_local_step_count :=
    unbound_step_count - cardinality(provider_handoff_step_ids);

  -- Preserve the already-deployed wallet-route handoff contract. New
  -- multi-action venue preparation is owned by the application validator.
  select count(*)::integer
  into invalid_pre_route_handoff_count
  from funding_operation_steps pre_route_step
  where pre_route_step.operation_id = target_operation_id
    and pre_route_step.segment_id is null
    and not (pre_route_step.id = any(provider_handoff_step_ids))
    and pre_route_step.step_kind = 'external_handoff'
    and funding_is_owned_controller_handoff(pre_route_step.executor_id, pre_route_step.normalized_action)
    and (
      (not supports_unbound_preparation_chain and pre_route_step.depends_on_step_id is not null)
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
    from (
      select funding_step.*,
        row_number() over (order by funding_step.ordinal) - 1 as preparation_ordinal,
        lag(funding_step.id) over (order by funding_step.ordinal) as previous_preparation_id
      from funding_operation_steps funding_step
      where funding_step.operation_id = target_operation_id
        and funding_step.segment_id is null
        and not (funding_step.id = any(provider_handoff_step_ids))
    ) preparation_step
    where (
      preparation_step.depends_on_step_id is distinct from preparation_step.previous_preparation_id
      or (
        preparation_step.step_kind = 'venue_preparation'
        and preparation_step.preparation_ordinal <> preparation_local_step_count - 1
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
