alter table telegram_bot_action_outbox
  drop constraint telegram_bot_action_outbox_delivery_unknown_check;

-- A photo upload has the same unknowable transport boundary as a message send:
-- after a timeout it must be quarantined, never sent again blindly.
alter table telegram_bot_action_outbox
  add constraint telegram_bot_action_outbox_delivery_unknown_check
    check (
      status <> 'delivery_unknown'
      or action in (
        'welcome_menu',
        'funding_send',
        'funding_replacement',
        'funding_qr'
      )
    );

-- A funding context owns one Telegram message for its entire life. Relinking
-- may rearm an edit of that message, but must never copy-send and rebind the
-- context. Historical send/replacement rows remain only as delivery evidence.
create or replace function rearm_telegram_funding_delivery(
  target_telegram_user_id text,
  target_telegram_account_id uuid
)
returns integer
language plpgsql
as $$
declare
  rearmed_count integer := 0;
  affected_count integer := 0;
  recovery record;
  stale_attempt record;
begin
  for stale_attempt in
    select
      outbox.id,
      outbox.delivery_attempt_id,
      context.id as context_id
    from telegram_bot_action_outbox outbox
    join telegram_funding_sessions context
      on context.id = outbox.funding_session_id
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    where context.telegram_user_id = target_telegram_user_id
      and outbox.action in ('funding_send', 'funding_replacement')
      and outbox.status = 'sending'
      and outbox.updated_at <= now() - interval '5 minutes'
    for update of outbox, context
  loop
    update telegram_bot_action_outbox outbox
    set status = 'delivery_unknown',
        last_error = 'funding_send_outcome_unknown',
        updated_at = now()
    where outbox.id = stale_attempt.id
      and outbox.status = 'sending';

    update telegram_funding_sessions context
    set delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = stale_attempt.context_id
      and context.delivery_lease_outbox_id = stale_attempt.id
      and context.delivery_lease_attempt_id = stale_attempt.delivery_attempt_id;
  end loop;

  update telegram_funding_sessions context
  set telegram_account_id = target_telegram_account_id
  from user_telegram_accounts account
  where account.id = target_telegram_account_id
    and account.telegram_user_id = target_telegram_user_id
    and account.user_id = context.user_id
    and context.telegram_user_id = target_telegram_user_id
    and context.telegram_account_id is distinct from target_telegram_account_id;

  for recovery in
    select
      context.id,
      context.user_id,
      context.telegram_user_id,
      case
        when context.address_disclosure_attempt_revision >
             context.address_redacted_revision
          then redaction.state_revision
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.action in ('funding_send', 'funding_replacement')
            and unknown.status = 'delivery_unknown'
        ) then context.progress_revision
        else context.latest_terminal_revision
      end as delivery_revision,
      case
        when context.address_disclosure_attempt_revision >
             context.address_redacted_revision
          then redaction.payload
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.action in ('funding_send', 'funding_replacement')
            and unknown.status = 'delivery_unknown'
        ) then context.latest_progress_projection
        else context.latest_terminal_projection
      end as delivery_projection
    from telegram_funding_sessions context
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    left join lateral (
      select outbox.state_revision, outbox.payload
      from telegram_bot_action_outbox outbox
      where outbox.funding_session_id = context.id
        and outbox.action = 'funding_edit'
        and outbox.state_revision > context.address_disclosure_attempt_revision
        and outbox.payload ->> 'terminal' = 'true'
        and (
          not (outbox.payload ? 'receiveAddress')
          or outbox.payload -> 'receiveAddress' = 'null'::jsonb
        )
      order by outbox.state_revision desc, outbox.created_at desc
      limit 1
    ) redaction on true
    where context.telegram_user_id = target_telegram_user_id
      and context.latest_progress_projection is not null
      and (
        (
          context.address_disclosure_attempt_revision >
            context.address_redacted_revision
          and context.address_disclosure_message_id is not null
          and redaction.state_revision is not null
        )
        or (
          context.address_disclosure_attempt_revision <=
            context.address_redacted_revision
          and context.telegram_message_id is not null
          and (
            (
              (
                context.latest_terminal_revision > context.last_delivered_revision
                or (
                  context.latest_terminal_revision is not null
                  and not exists (
                    select 1
                    from telegram_bot_action_outbox delivered
                    where delivered.funding_session_id = context.id
                      and delivered.state_revision = context.latest_terminal_revision
                      and delivered.telegram_account_id = target_telegram_account_id
                      and delivered.action in (
                        'funding_send',
                        'funding_edit',
                        'funding_replacement'
                      )
                      and delivered.status = 'sent'
                  )
                )
              )
              and (
                not (context.latest_terminal_projection ? 'receiveAddress')
                or context.latest_terminal_projection -> 'receiveAddress' =
                    'null'::jsonb
              )
            )
            or (
              exists (
                select 1
                from telegram_bot_action_outbox unknown
                where unknown.funding_session_id = context.id
                  and unknown.action in ('funding_send', 'funding_replacement')
                  and unknown.status = 'delivery_unknown'
              )
              and (
                not (context.latest_progress_projection ? 'receiveAddress')
                or context.latest_progress_projection -> 'receiveAddress' =
                    'null'::jsonb
              )
            )
          )
        )
      )
      and not exists (
        select 1
        from telegram_bot_action_outbox active_attempt
        where active_attempt.funding_session_id = context.id
          and active_attempt.status = 'sending'
      )
    for update of context
  loop
    update telegram_funding_sessions context
    set telegram_account_id = target_telegram_account_id,
        delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = recovery.id;

    update telegram_bot_action_outbox outbox
    set status = 'skipped',
        last_error = 'funding_delivery_rearmed',
        delivery_attempt_id = null,
        delivery_started_at = null,
        updated_at = now()
    where outbox.funding_session_id = recovery.id
      and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
      and outbox.status in ('pending', 'retry', 'delivery_unknown');

    insert into telegram_bot_action_outbox (
      action,
      telegram_account_id,
      user_id,
      telegram_user_id,
      funding_session_id,
      state_revision,
      payload
    ) values (
      'funding_edit',
      target_telegram_account_id,
      recovery.user_id,
      recovery.telegram_user_id,
      recovery.id,
      recovery.delivery_revision,
      recovery.delivery_projection
    )
    on conflict (funding_session_id, state_revision, action)
      where action in ('funding_send', 'funding_edit', 'funding_replacement')
    do update
      set telegram_account_id = excluded.telegram_account_id,
          payload = excluded.payload,
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = null,
          delivery_attempt_id = null,
          delivery_started_at = null,
          sent_at = null,
          updated_at = now();
    get diagnostics affected_count = row_count;
    rearmed_count := rearmed_count + affected_count;
  end loop;
  return rearmed_count;
end;
$$;
