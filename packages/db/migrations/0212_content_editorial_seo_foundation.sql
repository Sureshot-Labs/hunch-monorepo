-- Add an explicit editorial content type to immutable CMS snapshots.
--
-- The value lives on drafts and versions rather than content_articles so a
-- scheduled or published article keeps the type that was reviewed with that
-- exact snapshot.

alter table content_article_drafts
  add column content_kind text not null default 'guide';

alter table content_article_drafts
  add constraint content_article_drafts_content_kind_check
  check (content_kind in ('guide', 'news', 'analysis', 'research', 'update'));

alter table content_article_versions
  add column content_kind text not null default 'guide';

alter table content_article_versions
  add constraint content_article_versions_content_kind_check
  check (content_kind in ('guide', 'news', 'analysis', 'research', 'update'));

create index idx_content_article_versions_content_kind_created
  on content_article_versions (content_kind, created_at desc, id desc)
  where kind in ('published', 'scheduled');
