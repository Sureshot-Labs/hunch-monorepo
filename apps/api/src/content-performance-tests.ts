// @requires-db

import assert from "node:assert/strict";

import { createPgPool } from "@hunch/infra";

const connectionString = process.env.CONTENT_TEST_DATABASE_URL?.trim();
if (!connectionString) throw new Error("CONTENT_TEST_DATABASE_URL is required");

const rowCount = Math.max(
  10_000,
  Math.min(100_000, Number(process.env.CONTENT_PERF_ROWS ?? 20_000)),
);
const maxListMs = Number(process.env.CONTENT_PERF_MAX_LIST_MS ?? 250);
const maxDetailMs = Number(process.env.CONTENT_PERF_MAX_DETAIL_MS ?? 75);
const maxSearchMs = Number(process.env.CONTENT_PERF_MAX_SEARCH_MS ?? 300);
const maxCleanupMs = Number(process.env.CONTENT_PERF_MAX_CLEANUP_MS ?? 30_000);
const pool = createPgPool({ connectionString, max: 2 });
const prefix = `perf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rareSearchToken = `perfsearch${Date.now()}${Math.random()
  .toString(36)
  .slice(2, 8)}`;
let cleanupMs = 0;

type ExplainNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: ExplainNode[];
};

type ExplainDocument = {
  Plan: ExplainNode;
  "Execution Time": number;
  "Planning Time": number;
};

function flattenPlan(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

async function explain(
  name: string,
  sql: string,
  values: unknown[],
  maximumMs: number,
) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `explain (analyze, buffers, format json) ${sql}`,
    values,
  );
  const raw = rows[0]?.["QUERY PLAN"];
  assert.ok(Array.isArray(raw) && raw[0]);
  const document = raw[0] as ExplainDocument;
  const nodes = flattenPlan(document.Plan);
  assert.ok(
    document["Execution Time"] <= maximumMs,
    `${name} took ${document["Execution Time"]}ms (limit ${maximumMs}ms)`,
  );
  return {
    name,
    executionMs: document["Execution Time"],
    planningMs: document["Planning Time"],
    nodes: nodes.map((node) => ({
      type: node["Node Type"],
      relation: node["Relation Name"] ?? null,
      index: node["Index Name"] ?? null,
    })),
  };
}

try {
  const requiredForeignKeyIndexes = [
    "idx_content_articles_published_version_owner",
    "idx_content_articles_scheduled_version_owner",
    "idx_content_asset_usages_version_owner",
    "idx_content_publication_jobs_version_owner",
    "idx_content_outbox_article",
    "idx_content_outbox_version_owner",
  ];
  const { rows: foreignKeyIndexRows } = await pool.query<{ indexname: string }>(
    `
      select indexname
      from pg_indexes
      where schemaname = 'public' and indexname = any($1::text[])
    `,
    [requiredForeignKeyIndexes],
  );
  assert.deepEqual(
    foreignKeyIndexRows.map((row) => row.indexname).sort(),
    [...requiredForeignKeyIndexes].sort(),
    "content foreign-key support indexes are incomplete",
  );

  await pool.query(
    `
      create temporary table content_perf_seed (
        n integer primary key,
        article_id uuid not null,
        version_id uuid not null,
        slug text not null,
        published_at timestamptz not null
      )
    `,
  );
  await pool.query(
    `
      insert into content_perf_seed (n, article_id, version_id, slug, published_at)
      select
        n,
        gen_random_uuid(),
        gen_random_uuid(),
        $1 || '-' || n::text,
        now() - n * interval '1 second'
      from generate_series(1, $2::integer) n
    `,
    [prefix, rowCount],
  );
  await pool.query(
    `
      insert into content_articles (
        id, editorial_status, published_tag_slugs
      )
      select
        article_id, 'approved', array['benchmark']::text[]
      from content_perf_seed
    `,
  );
  await pool.query(
    `
      insert into content_article_drafts (
        article_id, slug, title, excerpt, document, seo, author, tags,
        tag_slugs, plain_text, word_count, reading_time_minutes, toc,
        content_hash, updated_at
      )
      select
        article_id,
        slug,
        'Benchmark article ' || n::text,
        'Benchmark excerpt',
        '{"schemaVersion":1,"blocks":[]}'::jsonb,
        '{}'::jsonb,
        '{"name":"Hunch"}'::jsonb,
        '[{"slug":"benchmark","label":"Benchmark"}]'::jsonb,
        array['benchmark']::text[],
        case when n % 997 = 0 then $1 else 'benchmark body' end,
        2,
        1,
        '[]'::jsonb,
        repeat('a', 64),
        published_at
      from content_perf_seed
    `,
    [rareSearchToken],
  );
  await pool.query(
    `
      insert into content_article_versions (
        id, article_id, version_number, source_draft_revision, kind,
        schema_version, slug, title, excerpt, document, seo, author, tags,
        tag_slugs, locale, featured, plain_text, word_count,
        reading_time_minutes, toc, content_hash, created_at
      )
      select
        version_id,
        article_id,
        1,
        1,
        'published',
        1,
        slug,
        'Benchmark article ' || n::text,
        'Benchmark excerpt',
        '{"schemaVersion":1,"blocks":[]}'::jsonb,
        '{}'::jsonb,
        '{"name":"Hunch"}'::jsonb,
        '[{"slug":"benchmark","label":"Benchmark"}]'::jsonb,
        array['benchmark']::text[],
        'en',
        false,
        'benchmark body',
        2,
        1,
        '[]'::jsonb,
        repeat('a', 64),
        published_at
      from content_perf_seed
    `,
  );
  await pool.query(
    `
      update content_articles article
      set
        published_version_id = seed.version_id,
        published_slug = seed.slug,
        first_published_at = seed.published_at,
        published_at = seed.published_at
      from content_perf_seed seed
      where article.id = seed.article_id
    `,
  );
  await pool.query(
    `
      insert into content_routes (slug, article_id, kind, has_been_published)
      select slug, article_id, 'current', true from content_perf_seed
    `,
  );
  await pool.query("analyze content_articles");
  await pool.query("analyze content_article_drafts");
  await pool.query("analyze content_article_versions");
  await pool.query("analyze content_routes");

  const { rows: cursorRows } = await pool.query<{
    article_id: string;
    published_at: Date | string;
  }>(
    `
      select article_id, published_at
      from content_perf_seed
      order by published_at desc, article_id desc
      offset $1 limit 1
    `,
    [Math.floor(rowCount * 0.8)],
  );
  const { rows: detailRows } = await pool.query<{ slug: string }>(
    "select slug from content_perf_seed where n = $1",
    [Math.floor(rowCount / 2)],
  );
  const { rows: relatedRows } = await pool.query<{ article_id: string }>(
    "select article_id from content_perf_seed where n <= 12 order by n",
  );
  const cursor = cursorRows[0];
  const plans = [];

  plans.push(
    await explain(
      "public-first-page",
      `
        with page as materialized (
          select id, published_version_id, first_published_at, published_at
          from content_articles
          where published_version_id is not null and archived_at is null
          order by published_at desc, id desc
          limit $1
        )
        select page.id, version.title
        from page
        join content_article_versions version on version.id = page.published_version_id
        order by page.published_at desc, page.id desc
      `,
      [51],
      maxListMs,
    ),
  );
  plans.push(
    await explain(
      "public-deep-keyset-page",
      `
        with page as materialized (
          select id, published_version_id, published_at
          from content_articles
          where published_version_id is not null
            and archived_at is null
            and (published_at, id) < ($1::timestamptz, $2::uuid)
          order by published_at desc, id desc
          limit $3
        )
        select page.id, version.title
        from page
        join content_article_versions version on version.id = page.published_version_id
        order by page.published_at desc, page.id desc
      `,
      [cursor.published_at, cursor.article_id, 51],
      maxListMs,
    ),
  );
  plans.push(
    await explain(
      "public-detail-by-route",
      `
        select article.id, version.document
        from content_routes route
        join content_articles article on article.id = route.article_id
        join content_article_versions version on version.id = article.published_version_id
        where route.slug = $1
          and route.kind in ('current', 'redirect')
          and article.archived_at is null
        limit 1
      `,
      [detailRows[0].slug],
      maxDetailMs,
    ),
  );
  plans.push(
    await explain(
      "public-related-articles-batch",
      `
        select article.id, version.title
        from content_articles article
        join content_article_versions version
          on version.id = article.published_version_id
        where article.id = any($1::uuid[])
          and article.published_version_id is not null
          and article.archived_at is null
      `,
      [relatedRows.map((row) => row.article_id)],
      maxDetailMs,
    ),
  );
  plans.push(
    await explain(
      "admin-first-page",
      `
        with page as materialized (
          select draft.article_id, draft.updated_at
          from content_article_drafts draft
          join content_articles article on article.id = draft.article_id
          where article.archived_at is null
          order by draft.updated_at desc, draft.article_id desc
          limit $1
        )
        select page.article_id, draft.title
        from page
        join content_article_drafts draft on draft.article_id = page.article_id
        order by page.updated_at desc, page.article_id desc
      `,
      [51],
      maxListMs,
    ),
  );
  plans.push(
    await explain(
      "admin-full-text-search",
      `
        select article_id
        from content_article_drafts
        where search_document @@ websearch_to_tsquery('simple', $1)
        limit $2
      `,
      [rareSearchToken, 51],
      maxSearchMs,
    ),
  );

  for (const plan of plans.slice(0, -1)) {
    const coreSequentialScan = plan.nodes.find(
      (node) =>
        node.type === "Seq Scan" &&
        [
          "content_articles",
          "content_article_drafts",
          "content_article_versions",
          "content_routes",
        ].includes(node.relation ?? ""),
    );
    assert.equal(
      coreSequentialScan,
      undefined,
      `${plan.name} unexpectedly uses a sequential scan on ${coreSequentialScan?.relation}`,
    );
  }
  assert.ok(
    plans
      .at(-1)
      ?.nodes.some(
        (node) =>
          node.type === "Bitmap Index Scan" &&
          node.index === "idx_content_article_drafts_search_gin",
      ),
    `full-text search did not use the GIN index: ${JSON.stringify(plans.at(-1))}`,
  );

  console.log(
    JSON.stringify(
      {
        test: "content-performance",
        rowCount,
        plans: plans.map(({ name, executionMs, planningMs, nodes }) => ({
          name,
          executionMs,
          planningMs,
          indexes: nodes
            .map((node) => node.index)
            .filter((index): index is string => Boolean(index)),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  try {
    const cleanupStartedAt = performance.now();
    await pool.query(
      `
        delete from content_articles article
        using content_perf_seed seed
        where article.id = seed.article_id
      `,
    );
    cleanupMs = performance.now() - cleanupStartedAt;
  } finally {
    await pool.end();
  }
}

assert.ok(
  cleanupMs <= maxCleanupMs,
  `${rowCount}-row cascade cleanup took ${cleanupMs.toFixed(1)}ms (limit ${maxCleanupMs}ms)`,
);
console.log(
  `[content-performance-tests] ${rowCount}-row cleanup ${cleanupMs.toFixed(1)}ms (limit ${maxCleanupMs}ms)`,
);
console.log("[content-performance-tests] passed");
