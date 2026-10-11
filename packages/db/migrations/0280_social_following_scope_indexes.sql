/* no-transaction */
-- Following pages need both author and scope before chronology. Build without
-- blocking publication. Retain the author-only index for unfiltered Following.
create index concurrently if not exists user_theses_author_market_public_page
  on user_theses(author_id,market_id,published_at desc,id desc)
  where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
create index concurrently if not exists user_theses_author_event_public_page
  on user_theses(author_id,event_id,published_at desc,id desc)
  where author_hidden_at is null and moderation_hidden_at is null and proof_invalidated_at is null;
