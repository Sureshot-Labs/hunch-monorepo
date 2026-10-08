/* no-transaction */
-- Existing AI table: avoid blocking publication while creating the social read indexes.
create index concurrently if not exists ai_notes_social_public_page
  on ai_notes(created_at desc,id desc)
  where producer_type='holder_research' and source_kind='market' and status<>'retracted'
    and ((note_type='signal' and metrics #>> '{publicationDecisionV1,status}'='PUBLISH'
      and metrics #>> '{publicationDecisionV1,authority}'='holder_research_quality_gate')
      or (note_type='context' and metrics ? 'publicContextV1'));
create index concurrently if not exists ai_notes_social_market_page
  on ai_notes(source_id,created_at desc,id desc)
  where producer_type='holder_research' and source_kind='market' and status<>'retracted'
    and ((note_type='signal' and metrics #>> '{publicationDecisionV1,status}'='PUBLISH'
      and metrics #>> '{publicationDecisionV1,authority}'='holder_research_quality_gate')
      or (note_type='context' and metrics ? 'publicContextV1'));
