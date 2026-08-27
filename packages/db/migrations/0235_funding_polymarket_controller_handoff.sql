-- A client-executed Polymarket preparation may first return an exact USDC.e
-- amount from the Deposit Wallet to its controller, then execute the ordinary
-- Router-v2 approval/fund chain. Keep that exception linear and narrow: the
-- Deposit Wallet never approves the Router and no server executor may consume
-- the handoff step.
create or replace function funding_validate_operation_segment_shape(
  target_operation_id uuid
)
returns void
language plpgsql
as $$
declare
  operation_plan_kind text;
  operation_venue_id text;
  operation_support_metadata jsonb;
  is_polymarket_router_operation boolean;
  segment_count integer;
  relay_segment_count integer;
  relay_deposit_segment_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  step_count integer;
  unbound_step_count integer;
  venue_preparation_step_count integer;
  pre_route_handoff_step_count integer;
  router_approval_step_count integer;
  distinct_router_approval_kind_count integer;
  invalid_step_binding_count integer;
  invalid_pre_route_handoff_count integer;
  invalid_linear_dependency_count integer;
  invalid_router_chain_count integer;
  minimum_step_ordinal integer;
  maximum_step_ordinal integer;
  preparation_executor_id text;
  preparation_step_state text;
  segment_without_step_count integer;
  segment_without_reservation_count integer;
  invalid_observation_binding_count integer;
  invalid_reservation_binding_count integer;
  source_reservation_count integer;
  unbound_source_reservation_count integer;
begin
  select
    operation_row.plan_kind,
    operation_row.venue_id,
    operation_row.support_metadata
  into
    operation_plan_kind,
    operation_venue_id,
    operation_support_metadata
  from funding_operations operation_row
  where operation_row.id = target_operation_id;

  if operation_plan_kind is null then
    return;
  end if;

  is_polymarket_router_operation := coalesce(
    operation_plan_kind = 'venue_preparation'
      and operation_venue_id = 'polymarket'
      and operation_support_metadata ->> 'preparationKind'
        = 'polymarket_funding_router'
      and operation_support_metadata ->> 'adapterId'
        = 'polymarket_funding_router_v1',
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
      where funding_step.segment_id is null
        and operation_plan_kind = 'venue_preparation'
        and funding_step.step_kind = 'transaction'
        and funding_step.normalized_action ->> 'kind' = 'evm_transaction'
        and funding_step.action_validation_result ->> 'kind' in (
          'controller_pusd_router_approval',
          'controller_usdce_router_approval'
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
          and not (
            operation_plan_kind = 'venue_preparation'
            and funding_step.step_kind = 'transaction'
            and funding_step.normalized_action ->> 'kind' = 'evm_transaction'
            and funding_step.action_validation_result ->> 'kind' in (
              'controller_pusd_router_approval',
              'controller_usdce_router_approval'
            )
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
    router_approval_step_count,
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
    raise exception 'only exact venue preparation, controller approval, or Polymarket pre-route handoff steps may be unbound'
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
          and (
            (
              operation_plan_kind = 'venue_preparation'
              and dependent_step.segment_id is null
            )
            or (
              operation_plan_kind in ('wallet_route', 'composite_route')
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

  if operation_plan_kind = 'venue_preparation' then
    if step_count = 1 then
      if venue_preparation_step_count <> 1 then
        raise exception 'venue preparation plan requires one exact preparation step'
          using errcode = '23514';
      end if;
    else
      if not is_polymarket_router_operation then
        raise exception 'only the exact Polymarket Funding Router may use multi-step venue preparation'
          using errcode = '23514';
      end if;

      if step_count < 2
        or step_count > 4
        or venue_preparation_step_count <> 1
        or pre_route_handoff_step_count > 1
        or router_approval_step_count
          <> step_count - venue_preparation_step_count - pre_route_handoff_step_count then
        raise exception 'Polymarket venue preparation has an invalid handoff/approval/fund shape'
          using errcode = '23514';
      end if;

      select executor_id, state
      into preparation_executor_id, preparation_step_state
      from funding_operation_steps
      where operation_id = target_operation_id
        and step_kind = 'venue_preparation'
        and normalized_action ->> 'kind' = 'evm_transaction'
        and action_validation_result ->> 'validatorId'
          = 'polymarket_funding_router_v1';

      if not (
        (
          preparation_executor_id = 'wallet_profile_evm_v1'
          and preparation_step_state = 'action_required'
        )
        or (
          preparation_executor_id = 'polymarket_deposit_pusd_fund_v1'
          and preparation_step_state = 'planned'
        )
      ) then
        raise exception 'Polymarket venue preparation executor and state differ'
          using errcode = '23514';
      end if;

      if pre_route_handoff_step_count = 1
        and preparation_executor_id <> 'wallet_profile_evm_v1' then
        raise exception 'Polymarket Deposit Wallet handoff requires client execution'
          using errcode = '23514';
      end if;

      select count(*)::integer
      into invalid_linear_dependency_count
      from funding_operation_steps funding_step
      where funding_step.operation_id = target_operation_id
        and (
          (
            funding_step.ordinal = 0
            and funding_step.depends_on_step_id is not null
          )
          or (
            funding_step.ordinal > 0
            and not exists (
              select 1
              from funding_operation_steps previous_step
              where previous_step.operation_id = funding_step.operation_id
                and previous_step.ordinal = funding_step.ordinal - 1
                and funding_step.depends_on_step_id = previous_step.id
            )
          )
        );
      if invalid_linear_dependency_count <> 0 then
        raise exception 'Polymarket venue preparation steps must form one linear dependency chain'
          using errcode = '23514';
      end if;

      select count(*)::integer
      into invalid_router_chain_count
      from funding_operation_steps funding_step
      where funding_step.operation_id = target_operation_id
        and (
          (
            funding_step.step_kind = 'venue_preparation'
            and funding_step.ordinal <> step_count - 1
          )
          or (
            funding_step.step_kind = 'external_handoff'
            and (
              funding_step.ordinal <> 0
              or funding_step.state is distinct from 'action_required'
              or funding_step.executor_id
                is distinct from 'polymarket_deposit_wallet_relayer_v1'
              or funding_step.normalized_action ->> 'kind'
                is distinct from 'external_handoff'
              or funding_step.normalized_action ->> 'handoffKind'
                is distinct from 'polymarket_deposit_wallet_transfer'
              or funding_step.normalized_action -> 'payload' ->> 'topology'
                is distinct from 'deposit_wallet'
              or funding_step.action_validation_result ->> 'executionEnvelope'
                is distinct from 'polymarket_deposit_wallet_to_controller_v1'
            )
          )
          or (
            funding_step.step_kind = 'transaction'
            and (
              funding_step.executor_id <> preparation_executor_id
              or funding_step.state <> preparation_step_state
            )
          )
          or (
            funding_step.step_kind = 'venue_preparation'
            and (
              funding_step.normalized_action ->> 'kind'
                is distinct from 'evm_transaction'
              or funding_step.action_validation_result ->> 'validatorId'
                is distinct from 'polymarket_funding_router_v1'
            )
          )
        );
      if invalid_router_chain_count <> 0 then
        raise exception 'Polymarket venue preparation steps cannot change executor, state, or order'
          using errcode = '23514';
      end if;

      select count(distinct funding_step.action_validation_result ->> 'kind')::integer
      into distinct_router_approval_kind_count
      from funding_operation_steps funding_step
      where funding_step.operation_id = target_operation_id
        and funding_step.step_kind = 'transaction';
      if distinct_router_approval_kind_count <> router_approval_step_count then
        raise exception 'Polymarket venue preparation contains duplicate controller approvals'
          using errcode = '23514';
      end if;
    end if;
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
