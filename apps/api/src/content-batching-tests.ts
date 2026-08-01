// @requires-db

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createPgPool, type Pool, type PoolClient } from "@hunch/infra";

import type { ContentDocument } from "./schemas/content-blocks.js";
import { createContentArticle } from "./services/content.js";

const connectionString = process.env.CONTENT_TEST_DATABASE_URL?.trim();
if (!connectionString) throw new Error("CONTENT_TEST_DATABASE_URL is required");

const pool = createPgPool({ connectionString, max: 1 });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const assetIds = Array.from({ length: 500 }, () => randomUUID());
const articleIds: string[] = [];

async function withClientQueryCount<T>(
  targetPool: Pool,
  operation: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  let queries = 0;
  const originalConnect = targetPool.connect.bind(targetPool);
  targetPool.connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    client.query = ((...args: unknown[]) => {
      queries += 1;
      return Reflect.apply(originalQuery, client, args);
    }) as PoolClient["query"];
    client.release = ((error?: Error | boolean) => {
      client.query = originalQuery as PoolClient["query"];
      client.release = originalRelease;
      originalRelease(error);
    }) as PoolClient["release"];
    return client;
  }) as Pool["connect"];
  try {
    return { result: await operation(), queries };
  } finally {
    targetPool.connect = originalConnect as Pool["connect"];
  }
}

function documentWithAssetCount(count: number): ContentDocument {
  if (count === 1) {
    return {
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "image",
          version: 1,
          data: {
            assetId: assetIds[0],
            alt: "Single image",
            decorative: false,
            crop: "original",
            presentation: "inline",
          },
        },
      ],
    };
  }
  return {
    schemaVersion: 1,
    blocks: Array.from({ length: count / 50 }, (_, galleryIndex) => ({
      id: randomUUID(),
      type: "gallery" as const,
      version: 1 as const,
      data: {
        layout: "grid" as const,
        columns: 4,
        items: assetIds
          .slice(galleryIndex * 50, galleryIndex * 50 + 50)
          .map((assetId, itemIndex) => ({
            id: randomUUID(),
            assetId,
            alt: `Gallery ${galleryIndex + 1}, image ${itemIndex + 1}`,
            decorative: false,
          })),
      },
    })),
  };
}

try {
  await pool.query(
    `
      insert into content_assets (
        id, status, kind, storage_key, public_url, original_filename,
        mime_type, byte_size, width, height, checksum_sha256, ready_at
      )
      select
        source.id,
        'ready',
        'image',
        $2 || '/' || source.ordinality::text || '.png',
        'https://cdn.example.com/' || source.id::text || '.png',
        source.ordinality::text || '.png',
        'image/png',
        1024,
        1200,
        630,
        repeat('2', 64),
        now()
      from unnest($1::uuid[]) with ordinality as source(id, ordinality)
    `,
    [assetIds, `tests/${suffix}`],
  );

  const single = await withClientQueryCount(pool, () =>
    createContentArticle(
      pool,
      {
        slug: `content-batching-single-${suffix}`,
        title: "Single asset batching control",
        document: documentWithAssetCount(1),
      },
      null,
    ),
  );
  articleIds.push(single.result.article.id);

  const many = await withClientQueryCount(pool, () =>
    createContentArticle(
      pool,
      {
        slug: `content-batching-many-${suffix}`,
        title: "Five hundred asset batching gate",
        document: documentWithAssetCount(500),
      },
      null,
    ),
  );
  articleIds.push(many.result.article.id);

  assert.equal(
    many.queries,
    single.queries,
    `query count grew from ${single.queries} to ${many.queries}`,
  );
  assert.ok(
    many.queries <= 12,
    `article creation used ${many.queries} queries`,
  );
  const { rows } = await pool.query<{ count: string }>(
    `
      select count(*)::text as count
      from content_asset_usages
      where article_id = $1 and scope = 'draft'
    `,
    [many.result.article.id],
  );
  assert.equal(rows[0].count, "500");

  console.log(
    `[content-batching-tests] passed (${many.queries} queries for 1 and 500 references)`,
  );
} finally {
  if (articleIds.length > 0) {
    await pool.query(
      "delete from content_articles where id = any($1::uuid[])",
      [articleIds],
    );
  }
  await pool.query("delete from content_assets where id = any($1::uuid[])", [
    assetIds,
  ]);
  await pool.end();
}
