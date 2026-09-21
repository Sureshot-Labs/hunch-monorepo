-- Run with psql -v ON_ERROR_STOP=1 against a disposable PostgreSQL 16 database.
-- Everything, including the isolated schema and replaced functions, rolls back.
begin;
set local statement_timeout = '10s';
create schema funding_handoff_shape_test;
set local search_path = funding_handoff_shape_test;
create table funding_operations (id uuid primary key, plan_kind text, support_metadata jsonb);
create table funding_operation_segments (id uuid primary key, operation_id uuid, ordinal integer, provider_id text, segment_kind text);
create table funding_operation_steps (id uuid primary key, operation_id uuid, ordinal integer, segment_id uuid, step_kind text, executor_id text, normalized_action jsonb, action_validation_result jsonb, depends_on_step_id uuid);
create table balance_reservations (operation_id uuid, segment_id uuid, mode text, economic_role text);
create table funding_observations (operation_id uuid, segment_id uuid, kind text);
\ir ../migrations/0249_funding_existing_safe_handoff.sql
\ir ../migrations/0254_funding_composite_preparation_ordinals.sql

insert into funding_operations values ('00000000-0000-0000-0000-000000000001', 'composite_route', '{"planValidation":{"validatorId":"polymarket_funding_router_v1","version":3}}');
insert into funding_operation_segments values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 0, 'relay', 'same_network_swap');
-- Sanitized topology of production quote 709fb62e-ecc4-4d4c-95fd-fdad19835285:
-- independent Safe->Router and Safe->Relay contributors, not one linear chain.
insert into funding_operation_steps
select ('00000000-0000-0000-0000-' || lpad((10+fixture.ordinal)::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001', fixture.ordinal,
 case when fixture.ordinal=3 then '00000000-0000-0000-0000-000000000002'::uuid end,
 fixture.step_kind,
 case when fixture.ordinal in (0,2) then 'polymarket_safe_relayer_v1' else 'wallet_profile_evm_v1' end,
 case when fixture.ordinal in (0,2) then '{"kind":"external_handoff","handoffKind":"polymarket_safe_transfer","payload":{"topology":"safe"}}'::jsonb else '{}'::jsonb end,
 jsonb_build_object('compositeSourceLegId',case when fixture.ordinal<2 then 'router-leg' else 'relay-leg' end,
   'compositeSegmentOrdinal',case when fixture.ordinal>=2 then 0 end),
 case when fixture.ordinal=1 then '00000000-0000-0000-0000-000000000010'::uuid
      when fixture.ordinal=3 then '00000000-0000-0000-0000-000000000012'::uuid end
from (values (0,'external_handoff'),(1,'venue_preparation'),(2,'external_handoff'),(3,'transaction')) fixture(ordinal,step_kind);
insert into balance_reservations values
 ('00000000-0000-0000-0000-000000000001',null,'subtract_available','source_input'),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','subtract_available','source_input');

do $$ begin
  begin
    perform funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
    raise exception 'baseline unexpectedly accepted production topology';
  exception when check_violation then
    if sqlerrm <> 'Polymarket pre-route handoff must directly gate its next exact route step' then raise; end if;
  end;
end $$;

\ir ../migrations/0262_funding_composite_handoff_contributors.sql
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');

create function expect_shape_rejection(mutation_sql text) returns void language plpgsql as $$
begin
  begin
    execute mutation_sql;
    perform funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
    raise exception 'unsafe shape accepted: %',mutation_sql;
  exception when check_violation then null;
  end;
end $$;

select expect_shape_rejection('update funding_operation_steps set depends_on_step_id=null where ordinal=3');
select expect_shape_rejection('update funding_operation_steps set depends_on_step_id=''00000000-0000-0000-0000-000000000010'' where ordinal=3');
select expect_shape_rejection('update funding_operation_steps set depends_on_step_id=''00000000-0000-0000-0000-000000000011'' where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set action_validation_result=jsonb_set(action_validation_result,''{compositeSegmentOrdinal}'',''1'') where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set action_validation_result=jsonb_set(action_validation_result,''{compositeSegmentOrdinal}'',''"0"'') where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set action_validation_result=jsonb_set(action_validation_result,''{compositeSourceLegId}'',''"other-leg"'') where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set action_validation_result=action_validation_result-''compositeSourceLegId'' where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set normalized_action=''{}'' where ordinal=2');
select expect_shape_rejection('update funding_operation_steps set depends_on_step_id=null where ordinal=1');
select expect_shape_rejection('delete from balance_reservations where segment_id is not null');
select expect_shape_rejection('delete from balance_reservations where segment_id is null');
select expect_shape_rejection('update funding_operation_segments set ordinal=1');

-- Reverse contributor order while retaining contributor-local dependency IDs.
savepoint provider_first;
update funding_operation_steps set ordinal=case ordinal when 0 then 2 when 1 then 3 when 2 then 0 else 1 end;
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
rollback to provider_first;

-- Deposit Wallet prefixes use the same exact-controller handoff contract.
savepoint deposit_wallet;
update funding_operation_steps set executor_id='polymarket_deposit_wallet_relayer_v1', normalized_action='{"kind":"external_handoff","handoffKind":"polymarket_deposit_wallet_transfer","payload":{"topology":"deposit_wallet"}}' where ordinal in (0,2);
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
rollback to deposit_wallet;

-- Router plus ordinary Relay remains valid, including historical untagged plans.
savepoint ordinary_relay;
delete from funding_operation_steps where ordinal=2;
update funding_operation_steps set ordinal=2,depends_on_step_id=null where ordinal=3;
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
update funding_operation_steps set action_validation_result='{}';
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
rollback to ordinary_relay;

-- A standalone Safe->Relay wallet route retains the existing contract.
savepoint wallet_route;
delete from funding_operation_steps where ordinal<2;
update funding_operation_steps set ordinal=ordinal-2,action_validation_result='{}';
delete from balance_reservations where segment_id is null;
update funding_operations set plan_kind='wallet_route',support_metadata='{}';
select funding_validate_operation_segment_shape('00000000-0000-0000-0000-000000000001');
rollback to wallet_route;

select 'PASS: production failure reproduced; mixed, reversed, deposit-wallet, legacy and wallet-route shapes validated; 12 unsafe mutations rejected';
rollback;
