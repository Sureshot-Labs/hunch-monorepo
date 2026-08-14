-- Versioned search strategy, entity relationships, and source provenance.
-- The graph remains a snapshot on drafts and versions so restoring a version
-- also restores the editorial decisions that produced it.

alter table content_article_drafts
  add column editorial_graph jsonb not null default
    '{"primaryIntent":"learn","queryCluster":null,"parentHubId":null,"topics":[],"venues":[],"markets":[],"entities":[],"sources":[]}'::jsonb;

alter table content_article_drafts
  add constraint content_article_drafts_editorial_graph_check
  check (jsonb_typeof(editorial_graph) = 'object');

alter table content_article_versions
  add column editorial_graph jsonb not null default
    '{"primaryIntent":"learn","queryCluster":null,"parentHubId":null,"topics":[],"venues":[],"markets":[],"entities":[],"sources":[]}'::jsonb;

alter table content_article_versions
  add constraint content_article_versions_editorial_graph_check
  check (jsonb_typeof(editorial_graph) = 'object');

-- Existing articles own their current slug as an initial query cluster. This
-- prevents the new publication gate from turning a legacy article into an
-- unpublishable draft on its next revision.
update content_article_drafts
set editorial_graph = jsonb_set(
  editorial_graph,
  '{queryCluster}',
  to_jsonb(slug),
  true
);

update content_article_versions
set editorial_graph = jsonb_set(
  editorial_graph,
  '{queryCluster}',
  to_jsonb(slug),
  true
);

create index idx_content_article_drafts_editorial_graph
  on content_article_drafts using gin (editorial_graph jsonb_path_ops);

create index idx_content_article_versions_query_cluster
  on content_article_versions (
    (editorial_graph->>'primaryIntent'),
    (editorial_graph->>'queryCluster'),
    created_at desc
  )
  where kind in ('published', 'scheduled');
