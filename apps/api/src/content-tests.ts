import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveContentRuntimeConfig } from "@hunch/config/content";

import {
  CONTENT_RENDERER_CONTRACT_ID,
  contentDocumentSchema,
  type ContentDocument,
} from "./schemas/content-blocks.js";
import {
  contentAssetCompleteBodySchema,
  contentAssetCreateBodySchema,
  contentArticleCreateBodySchema,
  contentArticleUpdateBodySchema,
  contentEditorialGraphSchema,
  publicContentArticlesQuerySchema,
} from "./schemas/content.js";
import {
  contentPayloadHash,
  deriveContentDocument,
  validateContentDocumentForPublication,
} from "./services/content-document.js";
import {
  createContentPreviewTokenForTests,
  verifyContentPreviewTokenForTests,
} from "./services/content-preview.js";
import { signContentRevalidationForTests } from "./services/content-revalidation.js";
import {
  ContentError,
  decodeContentCursor,
  type ContentArticle,
  validateArticlePublishability,
} from "./services/content.js";

function test(name: string, fn: () => void) {
  fn();
  console.log(`[content-tests] ok ${name}`);
}

const paragraphId = randomUUID();
const headingId = randomUUID();
const assetId = randomUUID();
const document: ContentDocument = {
  schemaVersion: 1,
  blocks: [
    {
      id: headingId,
      type: "heading",
      version: 1,
      data: {
        level: 2,
        content: [{ type: "text", text: "How prediction markets work" }],
      },
    },
    {
      id: paragraphId,
      type: "paragraph",
      version: 1,
      data: {
        content: [
          { type: "text", text: "Markets aggregate information." },
          {
            type: "link",
            text: "Read more",
            href: "https://hunch.trade",
            newWindow: false,
            rel: "default",
          },
        ],
      },
    },
  ],
};

test("normalizes slugs and de-duplicates structured tags", () => {
  const parsed = contentArticleCreateBodySchema.parse({
    slug: "  Prediction-Markets-Guide ",
    title: "Prediction Markets Guide",
    tags: [
      { slug: "Guides", label: "Guides" },
      { slug: "guides", label: "Duplicate" },
      { slug: "trading", label: "Trading" },
    ],
  });
  assert.equal(parsed.slug, "prediction-markets-guide");
  assert.deepEqual(parsed.tags, [
    { slug: "guides", label: "Guides" },
    { slug: "trading", label: "Trading" },
  ]);
});

test("normalizes the editorial graph and enforces source provenance", () => {
  const checkedAt = "2026-08-14T12:00:00.000Z";
  const parsed = contentEditorialGraphSchema.parse({
    primaryIntent: "trade",
    queryCluster: "trade-polymarket",
    topics: [
      { id: "Prediction-Markets", label: "Prediction markets" },
      { id: "prediction-markets", label: "Duplicate" },
    ],
    venues: [{ id: "polymarket", label: "Polymarket" }],
    sources: [
      {
        checkedAt,
        publishedAt: null,
        publisher: "Polymarket",
        sourceType: "official",
        title: "Trading documentation",
        url: "https://docs.polymarket.com/",
      },
      {
        checkedAt,
        publishedAt: null,
        publisher: "Duplicate",
        sourceType: "official",
        title: "Duplicate URL",
        url: "https://docs.polymarket.com/",
      },
    ],
  });
  assert.deepEqual(parsed.topics, [
    { id: "prediction-markets", label: "Prediction markets" },
  ]);
  assert.equal(parsed.sources.length, 1);
  assert.equal(
    contentEditorialGraphSchema.safeParse({
      sources: [
        {
          checkedAt,
          publishedAt: null,
          publisher: "Unsafe",
          sourceType: "reporting",
          title: "Plain HTTP",
          url: "http://example.com/article",
        },
      ],
    }).success,
    false,
  );
});

test("defaults and validates immutable editorial content kinds", () => {
  assert.equal(
    contentArticleCreateBodySchema.parse({
      slug: "prediction-markets-guide",
      title: "Prediction Markets Guide",
    }).contentKind,
    undefined,
  );
  assert.equal(
    contentArticleCreateBodySchema.safeParse({
      slug: "prediction-markets-news",
      title: "Prediction Markets News",
      contentKind: "news",
    }).success,
    true,
  );
  assert.equal(
    contentArticleCreateBodySchema.safeParse({
      slug: "prediction-markets-spam",
      title: "Prediction Markets Spam",
      contentKind: "seo-farm",
    }).success,
    false,
  );
});

test("defaults author bylines on and preserves an explicit opt-out", () => {
  const base = {
    slug: "author-byline-contract",
    title: "Author byline contract",
  };
  const defaulted = contentArticleCreateBodySchema.parse({
    ...base,
    author: { name: "Hunch" },
  });
  const hidden = contentArticleCreateBodySchema.parse({
    ...base,
    author: { name: "Hunch", showByline: false },
  });
  assert.equal(defaulted.author?.showByline, true);
  assert.equal(hidden.author?.showByline, false);
});

test("rejects unsafe slugs, arbitrary document fields, and unsafe links", () => {
  assert.equal(
    contentArticleCreateBodySchema.safeParse({
      slug: "../../article",
      title: "Article",
    }).success,
    false,
  );
  assert.equal(
    contentDocumentSchema.safeParse({
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "paragraph",
          version: 1,
          data: {
            content: [
              { type: "link", text: "unsafe", href: "javascript:alert(1)" },
            ],
          },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    contentDocumentSchema.safeParse({
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "embed",
          version: 1,
          data: {
            provider: "youtube",
            canonicalUrl: "https://attacker.example/watch/abc",
            resourceId: "abc",
          },
        },
      ],
    }).success,
    false,
  );
  const duplicateId = randomUUID();
  assert.equal(
    contentDocumentSchema.safeParse({
      schemaVersion: 1,
      blocks: [
        {
          id: duplicateId,
          type: "list",
          version: 1,
          data: {
            style: "bullet",
            items: [{ id: duplicateId, content: [] }],
          },
        },
      ],
    }).success,
    false,
  );
});

test("requires an actual field for optimistic draft updates", () => {
  assert.equal(
    contentArticleUpdateBodySchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
  assert.equal(
    contentArticleUpdateBodySchema.safeParse({
      expectedRevision: 1,
      excerpt: "Updated excerpt",
    }).success,
    true,
  );
});

test("requires a SHA-256 checksum for upload creation and completion", () => {
  assert.equal(
    contentAssetCreateBodySchema.safeParse({
      kind: "image",
      originalFilename: "cover.png",
      mimeType: "image/png",
      expectedByteSize: 100,
    }).success,
    false,
  );
  assert.equal(
    contentAssetCompleteBodySchema.safeParse({ byteSize: 100 }).success,
    false,
  );
});

test("rejects unsafe asset credit URLs", () => {
  const asset = {
    kind: "image",
    originalFilename: "image.png",
    mimeType: "image/png",
    expectedByteSize: 100,
    checksumSha256: "0".repeat(64),
  };
  assert.equal(
    contentAssetCreateBodySchema.safeParse({
      ...asset,
      creditUrl: "not a URL",
    }).success,
    false,
  );
  assert.equal(
    contentAssetCreateBodySchema.safeParse({
      ...asset,
      creditUrl: "javascript:alert(1)",
    }).success,
    false,
  );
  assert.equal(
    contentAssetCreateBodySchema.safeParse({
      ...asset,
      creditUrl: "https://user:password@example.com/source",
    }).success,
    false,
  );
});

test("coerces and bounds public pagination", () => {
  assert.equal(
    publicContentArticlesQuerySchema.parse({ limit: "25" }).limit,
    25,
  );
  assert.equal(
    publicContentArticlesQuerySchema.safeParse({ limit: "51" }).success,
    false,
  );
});

test("derives plain text, reading time, and a stable heading outline", () => {
  const derived = deriveContentDocument(document);
  assert.match(derived.plainText, /Markets aggregate information/);
  assert.equal(derived.toc[0]?.anchor, "how-prediction-markets-work");
  assert.equal(derived.toc[0]?.level, 2);
  assert.ok(derived.wordCount >= 6);
  assert.equal(derived.readingTimeMinutes, 1);
});

test("hashes equivalent payloads independently of object key order", () => {
  assert.equal(
    contentPayloadHash({ title: "A", seo: { index: true, follow: true } }),
    contentPayloadHash({ seo: { follow: true, index: true }, title: "A" }),
  );
});

test("validates footnote references against stable definitions", () => {
  const footnoteId = randomUUID();
  const valid = contentDocumentSchema.safeParse({
    schemaVersion: 1,
    blocks: [
      {
        id: randomUUID(),
        type: "paragraph",
        version: 1,
        data: {
          content: [{ type: "footnoteRef", footnoteId, label: "1" }],
        },
      },
      {
        id: randomUUID(),
        type: "footnotes",
        version: 1,
        data: {
          title: "Footnotes",
          items: [
            {
              id: footnoteId,
              label: "1",
              content: [{ type: "text", text: "Source note" }],
            },
          ],
        },
      },
    ],
  });
  assert.equal(valid.success, true);
  assert.equal(
    contentDocumentSchema.safeParse({
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "paragraph",
          version: 1,
          data: {
            content: [
              { type: "footnoteRef", footnoteId: randomUUID(), label: "1" },
            ],
          },
        },
      ],
    }).success,
    false,
  );
});

test("requires versioned strict snapshots for frozen market embeds", () => {
  assert.equal(
    contentDocumentSchema.safeParse({
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "marketCard",
          version: 1,
          data: { marketId: "market-1", mode: "snapshot" },
        },
      ],
    }).success,
    false,
  );
});

test("publication validation catches heading jumps and missing image alt", () => {
  const issues = validateContentDocumentForPublication({
    document: {
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "heading",
          version: 1,
          data: { level: 3, content: [{ type: "text", text: "Wrong level" }] },
        },
        {
          id: randomUUID(),
          type: "image",
          version: 1,
          data: {
            assetId,
            alt: "",
            decorative: false,
            crop: "original",
            presentation: "inline",
          },
        },
      ],
    },
    listCover: null,
    heroImage: null,
    socialImage: null,
  });
  assert.equal(issues.length, 2);
});

test("decodes typed opaque cursors", () => {
  const raw = Buffer.from(
    JSON.stringify({
      kind: "public",
      at: "2026-07-28T12:00:00.000Z",
      id: randomUUID(),
    }),
  ).toString("base64url");
  assert.equal(
    decodeContentCursor(raw, "public").at,
    "2026-07-28T12:00:00.000Z",
  );
  assert.throws(
    () => decodeContentCursor(raw, "admin"),
    (error) =>
      error instanceof ContentError && error.code === "content_cursor_invalid",
  );
  const invalidId = Buffer.from(
    JSON.stringify({
      kind: "public",
      at: "2026-07-28T12:00:00.000Z",
      id: "not-a-uuid",
    }),
  ).toString("base64url");
  assert.throws(() => decodeContentCursor(invalidId, "public"));
});

const publishableArticle: ContentArticle = {
  id: randomUUID(),
  status: "draft",
  editorialStatus: "draft",
  hasUnpublishedChanges: true,
  draft: {
    revision: 1,
    schemaVersion: 1,
    contentKind: "guide",
    editorialGraph: {
      primaryIntent: "learn",
      queryCluster: "prediction-markets-guide",
      parentHubId: null,
      topics: [{ id: "prediction-markets", label: "Prediction markets" }],
      venues: [],
      markets: [],
      entities: [],
      sources: [],
    },
    slug: "prediction-markets-guide",
    title: "Prediction Markets Guide",
    excerpt: "A practical guide.",
    document,
    listCover: {
      assetId,
      alt: "Prediction market dashboard",
      decorative: false,
      crop: "16:9",
      presentation: "cover",
    },
    heroImage: null,
    socialImage: null,
    seo: {
      title: null,
      description: null,
      canonicalUrl: null,
      robots: {
        index: true,
        follow: true,
        noarchive: false,
        nosnippet: false,
        noimageindex: false,
      },
      openGraphTitle: null,
      openGraphDescription: null,
      twitterTitle: null,
      twitterDescription: null,
    },
    author: {
      name: "Hunch",
      url: null,
      bio: null,
      avatarAssetId: null,
      showByline: true,
    },
    category: null,
    tags: [{ slug: "guides", label: "Guides" }],
    locale: "en",
    featured: false,
    plainText: "How prediction markets work Markets aggregate information.",
    wordCount: 7,
    readingTimeMinutes: 1,
    toc: [],
    contentHash: "a".repeat(64),
    updatedByAdminId: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  },
  published: null,
  scheduled: null,
  archivedAt: null,
  createdByAdminId: null,
  updatedByAdminId: null,
  publishedByAdminId: null,
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
};

test("validates publication completeness without touching the database", () => {
  assert.doesNotThrow(() => validateArticlePublishability(publishableArticle));
  assert.throws(
    () =>
      validateArticlePublishability({
        ...publishableArticle,
        draft: { ...publishableArticle.draft, excerpt: "", listCover: null },
      }),
    (error) =>
      error instanceof ContentError &&
      error.code === "content_article_not_publishable" &&
      error.issues?.length === 2,
  );
  assert.throws(
    () =>
      validateArticlePublishability({
        ...publishableArticle,
        draft: { ...publishableArticle.draft, contentKind: "news" },
      }),
    (error) =>
      error instanceof ContentError &&
      error.issues?.includes(
        "news articles require a dedicated social image",
      ) &&
      error.issues.includes(
        "news articles require a citation or references block",
      ),
  );
  assert.doesNotThrow(() =>
    validateArticlePublishability({
      ...publishableArticle,
      draft: {
        ...publishableArticle.draft,
        contentKind: "news",
        editorialGraph: {
          ...publishableArticle.draft.editorialGraph,
          primaryIntent: "news",
          sources: [
            {
              checkedAt: "2026-08-14T12:00:00.000Z",
              publishedAt: null,
              publisher: "CFTC",
              sourceType: "official",
              title: "Event contracts",
              url: "https://www.cftc.gov/",
            },
          ],
        },
        socialImage: publishableArticle.draft.listCover,
        author: {
          ...publishableArticle.draft.author,
          url: "https://hunch.trade/about",
          bio: "Hunch editorial team",
        },
      },
    }),
  );
});

test("signs revalidation payloads with timestamp-bound HMAC", () => {
  const secret = "test-secret";
  const timestamp = "1785240000";
  const body = '{"event":"article_published"}';
  const expected = `v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
  assert.equal(
    signContentRevalidationForTests(secret, timestamp, body),
    expected,
  );
});

test("signs short-lived preview tokens and rejects tampering", () => {
  const secret = "preview-secret-that-is-long-enough-for-tests";
  const articleId = randomUUID();
  const preview = createContentPreviewTokenForTests(secret, {
    articleId,
    revision: 7,
    ttlSeconds: 600,
  });
  const claims = verifyContentPreviewTokenForTests(preview.token, secret);
  assert.equal(claims.articleId, articleId);
  assert.equal(claims.revision, 7);
  assert.throws(
    () => verifyContentPreviewTokenForTests(`${preview.token}x`, secret),
    (error) =>
      error instanceof ContentError && error.code === "content_preview_invalid",
  );
});

test("supports AWS IAM-role storage without long-lived static keys", () => {
  const config = resolveContentRuntimeConfig(
    {
      AWS_REGION: "eu-north-1",
      CONTENT_ASSET_S3_REGION: "auto",
      CONTENT_ASSET_S3_BUCKET: "hunch-content-production",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://content.hunch.trade/",
    },
    "production",
  );
  assert.equal(config.assetStorageConfigured, true);
  assert.equal(config.assetStaticCredentialsConfigured, false);
  assert.equal(config.assetS3Endpoint, "");
  assert.equal(config.assetS3Region, "eu-north-1");
  assert.equal(config.assetPublicBaseUrl, "https://content.hunch.trade");
  assert.equal(config.assetS3ForcePathStyle, false);
});

test("defaults content off and validates production storage safely", () => {
  const defaults = resolveContentRuntimeConfig({}, "production");
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.publishingEnabled, false);
  assert.equal(defaults.workerEnabled, false);
  assert.throws(() =>
    resolveContentRuntimeConfig(
      {
        CONTENT_ASSET_S3_BUCKET: "content",
        CONTENT_ASSET_PUBLIC_BASE_URL: "https://cdn.example.com",
        CONTENT_ASSET_S3_ACCESS_KEY_ID: "access-only",
      },
      "production",
    ),
  );
  assert.throws(() =>
    resolveContentRuntimeConfig(
      { CONTENT_ASSET_S3_ENDPOINT: "https://s3.example.com" },
      "production",
    ),
  );
  assert.throws(() =>
    resolveContentRuntimeConfig(
      {
        CONTENT_ASSET_S3_BUCKET: "content",
        CONTENT_ASSET_PUBLIC_BASE_URL: "http://cdn.example.com",
      },
      "production",
    ),
  );
  assert.throws(
    () =>
      resolveContentRuntimeConfig(
        {
          CONTENT_ASSET_S3_BUCKET: "content",
          CONTENT_ASSET_S3_ACCESS_KEY_ID: "access",
          CONTENT_ASSET_S3_SECRET_ACCESS_KEY: "secret",
          CONTENT_ASSET_PUBLIC_BASE_URL: "https://cdn.example.com",
        },
        "production",
      ),
    /static content S3 credentials are forbidden/,
  );
});

test("requires a complete fail-closed publishing configuration", () => {
  assert.throws(
    () =>
      resolveContentRuntimeConfig(
        { CONTENT_PUBLISHING_ENABLED: "true" },
        "production",
      ),
    /CONTENT_ENABLED and CONTENT_WORKER_ENABLED/,
  );
  assert.doesNotThrow(() =>
    resolveContentRuntimeConfig(
      {
        CONTENT_ENABLED: "true",
        CONTENT_PUBLISHING_ENABLED: "true",
        CONTENT_WORKER_ENABLED: "true",
        CONTENT_RENDERER_CONTRACT_ID: "hunch-content-document-v1",
        CONTENT_REVALIDATE_URL:
          "https://www.hunch.trade/api/content/revalidate",
        CONTENT_REVALIDATE_SECRET: "r".repeat(32),
        CONTENT_ASSET_S3_BUCKET: "hunch-content",
        CONTENT_ASSET_PUBLIC_BASE_URL: "https://content.hunch.trade",
      },
      "production",
    ),
  );
});

test("registers gated protected routes and the content schema migrations", () => {
  const routes = readFileSync(
    new URL("./routes/index.ts", import.meta.url),
    "utf8",
  );
  const publicRoutes = readFileSync(
    new URL("./routes/content.ts", import.meta.url),
    "utf8",
  );
  const adminRoutes = readFileSync(
    new URL("./routes/admin-content.ts", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL(
      "../../../packages/db/migrations/0198_content_cms_adoption.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const editorialMigration = readFileSync(
    new URL(
      "../../../packages/db/migrations/0212_content_editorial_seo_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const editorialGraphMigration = readFileSync(
    new URL(
      "../../../packages/db/migrations/0213_content_editorial_graph.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const contentDb = readFileSync(
    new URL("./content-db.ts", import.meta.url),
    "utf8",
  );
  const prebuiltDeploy = readFileSync(
    new URL("../../../ops/deploy-ec2-prebuilt.sh", import.meta.url),
    "utf8",
  );
  const productionCompose = readFileSync(
    new URL("../../../ops/docker-compose.prod.yml", import.meta.url),
    "utf8",
  );
  const expectedPublicPaths = [
    "/content/articles",
    "/content/articles-index",
    "/content/articles/:slug",
    "/content/preview",
  ];
  const expectedAdminPaths = [
    "/admin/content/articles",
    "/admin/content/articles/:id",
    "/admin/content/articles/:id/approve",
    "/admin/content/articles/:id/archive",
    "/admin/content/articles/:id/audit",
    "/admin/content/articles/:id/cancel-schedule",
    "/admin/content/articles/:id/preview-token",
    "/admin/content/articles/:id/publish",
    "/admin/content/articles/:id/return-draft",
    "/admin/content/articles/:id/submit-review",
    "/admin/content/articles/:id/unpublish",
    "/admin/content/articles/:id/versions",
    "/admin/content/articles/:id/versions/:versionId",
    "/admin/content/articles/:id/versions/:versionId/restore",
    "/admin/content/assets",
    "/admin/content/assets/:id",
    "/admin/content/assets/:id/complete",
    "/admin/content/operations",
  ];
  const routePaths = (source: string, prefix: string) =>
    Array.from(
      new Set(
        [...source.matchAll(new RegExp(`"(${prefix}[^"]*)"`, "g"))]
          .map((match) => match[1])
          .filter((path): path is string => Boolean(path)),
      ),
    ).sort();
  assert.match(routes, /if \(env\.contentEnabled\)/);
  assert.match(routes, /import\("\.\/content\.js"\)/);
  assert.match(routes, /import\("\.\/admin-content\.js"\)/);
  assert.match(routes, /app\.register\(contentRoutes\)/);
  assert.match(routes, /app\.register\(adminContentRoutes\)/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:read"/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:write"/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:publish"/);
  assert.equal(
    [...adminRoutes.matchAll(/allowLegacyFallback: false/g)].length,
    3,
  );
  assert.deepEqual(
    routePaths(publicRoutes, "/content"),
    expectedPublicPaths.sort(),
  );
  assert.deepEqual(
    routePaths(adminRoutes, "/admin/content"),
    expectedAdminPaths.sort(),
  );
  assert.match(adminRoutes, /preview-token/);
  assert.match(adminRoutes, /cancel-schedule/);
  assert.match(migration, /content_article_drafts/);
  assert.match(migration, /content_article_versions/);
  assert.match(migration, /content_publication_jobs/);
  assert.match(migration, /content_outbox/);
  assert.match(migration, /idx_content_outbox_article/);
  assert.match(migration, /idx_content_publication_jobs_version_owner/);
  assert.match(
    migration,
    /drop table if exists public\.content_schema_migrations/,
  );
  for (const checksum of [
    "0373e4c34a83e3bc3256ec106be68573bf034a7f5a0639b439313264c1d724dd",
    "6f66d64b22d05d295ec3dfb290d56d66e59c44fd7c2eda50d4ca452a91553276",
    "aa3e82723ad92fcc79f979f46fdeea04f1be71aa474f10ee8ad03e5761e5be2c",
    "242f41d306d3b0edb97ed02ad0c958d0f1168430fb7100d9ea620fc44fbb95a7",
    "3a8c58ddf38a86f64d350154c07b2acc3473f3a3341f3150462d3f346af58ca6",
    "b4853af29c95fed4d57c77162f98a8275b181218fb6a683d32951779c9811037",
    "21676e2f0e476404d3d59bf4e527b356c58d88f0126a1e72f7acaf55685dc380",
  ]) {
    assert.equal(migration.split(checksum).length - 1, 1);
  }
  assert.equal(
    migration.split("6b8685c661ccd24753a4852e8d5cbb33").length - 1,
    2,
  );
  assert.match(migration, /required_constraint_count <> 16/);
  assert.match(migration, /content_outbox_version_id_fkey/);
  assert.match(editorialMigration, /content_kind/);
  assert.match(editorialMigration, /content_article_drafts_content_kind_check/);
  assert.match(
    editorialMigration,
    /content_article_versions_content_kind_check/,
  );
  assert.match(editorialGraphMigration, /editorial_graph jsonb not null/);
  assert.match(
    editorialGraphMigration,
    /content_article_drafts_editorial_graph_check/,
  );
  assert.match(
    editorialGraphMigration,
    /content_article_versions_editorial_graph_check/,
  );
  assert.match(
    editorialGraphMigration,
    /idx_content_article_drafts_editorial_graph/,
  );
  assert.match(
    editorialGraphMigration,
    /idx_content_article_versions_query_cluster/,
  );
  assert.match(
    editorialGraphMigration,
    /disable trigger content_article_versions_immutable/,
  );
  assert.match(
    editorialGraphMigration,
    /enable trigger content_article_versions_immutable/,
  );
  assert.ok(
    editorialGraphMigration.indexOf(
      "disable trigger content_article_versions_immutable",
    ) < editorialGraphMigration.indexOf("update content_article_versions"),
  );
  assert.ok(
    editorialGraphMigration.indexOf("update content_article_versions") <
      editorialGraphMigration.indexOf(
        "enable trigger content_article_versions_immutable",
      ),
  );
  assert.match(contentDb, /0222_content_service_actor\.sql/);
  assert.match(contentDb, /select count\(\*\) = 12/);
  assert.match(contentDb, /select count\(\*\) = 25/);
  assert.match(contentDb, /content_outbox_version_id_fkey/);
  assert.ok(
    prebuiltDeploy.indexOf('"${compose[@]}" run --rm api') <
      prebuiltDeploy.indexOf(
        '"${compose[@]}" stop "${application_services[@]}"',
      ),
  );
  const migrationFailureGuard = prebuiltDeploy.match(
    /if ! "\$\{compose\[@\]\}" run --rm api[\s\S]*?Migration failed; existing application containers were left running\.[\s\S]*?exit 1[\s\S]*?fi/,
  );
  assert.ok(migrationFailureGuard);
  assert.ok(
    prebuiltDeploy.indexOf(migrationFailureGuard[0]) <
      prebuiltDeploy.indexOf(
        '"${compose[@]}" stop "${application_services[@]}"',
      ),
  );
  assert.match(
    productionCompose,
    /CONTENT_REVALIDATE_URL: \$\{CONTENT_REVALIDATE_URL_OVERRIDE:-https:\/\/www\.hunch\.trade\/api\/content\/revalidate\}/,
  );
  assert.equal(CONTENT_RENDERER_CONTRACT_ID, "hunch-content-document-v1");
});

test("uses the main database and keeps content work out of the API process", () => {
  const envSource = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  const testRuntimeSource = readFileSync(
    new URL("./content-test-runtime.ts", import.meta.url),
    "utf8",
  );
  const testDatabaseTargetSource = readFileSync(
    new URL("./test-database-target.ts", import.meta.url),
    "utf8",
  );
  const testRunnerSource = readFileSync(
    new URL("./test-runner.ts", import.meta.url),
    "utf8",
  );
  const runtimeSource = readFileSync(
    new URL("./content-runtime.ts", import.meta.url),
    "utf8",
  );
  const apiSource = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(
    new URL("../../finance-worker/src/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(envSource, /contentDatabaseUrl: req\("DATABASE_URL"\)/);
  assert.doesNotMatch(envSource, /CONTENT_DATABASE_URL/);
  assert.match(testRuntimeSource, /createIntegrationTestPool\(\{ max \}\)/);
  assert.doesNotMatch(testRuntimeSource, /CONTENT_TEST_DATABASE_URL/);
  assert.match(testDatabaseTargetSource, /databaseUrl: source\.DATABASE_URL/);
  assert.match(
    testDatabaseTargetSource,
    /expectedDatabase: source\.HUNCH_TEST_EXPECT_DATABASE/,
  );
  assert.match(
    testDatabaseTargetSource,
    /integration tests require an explicit database URL and expected database/,
  );
  assert.match(
    testRunnerSource,
    /integration tests require --database-url and --expect-database/,
  );
  assert.match(testRunnerSource, /closeAcquiredRuntimeResources\(\)/u);
  assert.doesNotMatch(
    testRunnerSource,
    /finally\s*\{[\s\S]{0,500}?import\("\.\/(?:redis|db)\.js"\)/u,
  );
  assert.match(runtimeSource, /max: env\.contentDbPublicPoolMax/);
  assert.match(runtimeSource, /max: env\.contentDbAdminPoolMax/);
  assert.doesNotMatch(
    apiSource,
    /startContentWorker|setInterval\([^)]*content/,
  );
  assert.match(workerSource, /name: "content"/);
  assert.match(workerSource, /loadContentWorkerModule/);
});

console.log("[content-tests] passed");
