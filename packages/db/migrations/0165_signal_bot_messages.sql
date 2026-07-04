create table if not exists signal_bot_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  note_id uuid not null references ai_notes(id) on delete cascade,
  thread_root_note_id uuid not null references ai_notes(id) on delete cascade,
  message_kind text not null,
  telegram_message_id bigint,
  reply_to_message_id bigint,
  baseline_at timestamptz not null,
  sent_at timestamptz not null default now(),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    message_kind in (
      'initial',
      'research_update',
      'followthrough_stats',
      'resolved_win',
      'resolved_loss'
    )
  ),
  unique (chat_id, note_id, message_kind)
);

create index if not exists idx_signal_bot_messages_chat_thread
  on signal_bot_messages(chat_id, thread_root_note_id, sent_at desc);

create index if not exists idx_signal_bot_messages_note
  on signal_bot_messages(note_id, sent_at desc);

create index if not exists idx_signal_bot_messages_kind_sent
  on signal_bot_messages(message_kind, sent_at desc);
