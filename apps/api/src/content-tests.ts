import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
    author: { name: "Hunch", url: null, bio: null, avatarAssetId: null },
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

test("registers protected content routes and the isolated content migration", () => {
  const routes = readFileSync(
    new URL("./routes/index.ts", import.meta.url),
    "utf8",
  );
  const adminRoutes = readFileSync(
    new URL("./routes/admin-content.ts", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL(
      "../../../packages/db/content-migrations/0001_content_cms.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(routes, /app\.register\(contentRoutes\)/);
  assert.match(routes, /app\.register\(adminContentRoutes\)/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:read"/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:write"/);
  assert.match(adminRoutes, /requiredAdminPermission: "content:publish"/);
  assert.match(adminRoutes, /preview-token/);
  assert.match(adminRoutes, /cancel-schedule/);
  assert.match(migration, /content_article_drafts/);
  assert.match(migration, /content_article_versions/);
  assert.match(migration, /content_publication_jobs/);
  assert.match(migration, /content_outbox/);
  assert.equal(CONTENT_RENDERER_CONTRACT_ID, "hunch-content-document-v1");
});

test("keeps the content database fallback and deployment preflight fail-safe", () => {
  const envSource = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  const deployScript = readFileSync(
    new URL("../../../ops/deploy-ec2-prebuilt.sh", import.meta.url),
    "utf8",
  );
  const recoveryWorkflow = readFileSync(
    new URL(
      "../../../.github/workflows/recover-backend-existing-image.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    envSource,
    /contentDatabaseUrl = explicitContentDatabaseUrl \|\| req\("DATABASE_URL"\)/,
  );
  assert.doesNotMatch(
    envSource,
    /CONTENT_DATABASE_URL is required in production/,
  );
  const preflightAt = deployScript.indexOf("Preflighting new API environment");
  const shutdownAt = deployScript.indexOf('"${compose[@]}" down');
  assert.ok(preflightAt >= 0);
  assert.ok(shutdownAt > preflightAt);
  assert.ok(
    deployScript.includes(
      "node /app/packages/config/dist/run-with-secrets.js \\\n  /app/apps/api/dist/env.js",
    ),
  );
  assert.doesNotMatch(deployScript, /node --input-type=module/);
  assert.match(deployScript, /rollback_on_error/);
  assert.match(deployScript, /Restoring previous backend image/);
  assert.ok(recoveryWorkflow.includes("run -T --rm --no-deps api \\"));
  assert.ok(recoveryWorkflow.includes("/app/apps/api/dist/env.js </dev/null"));
  const recoveryServicesAt = recoveryWorkflow.indexOf("application_services=(");
  const recoveryRemovalAt = recoveryWorkflow.indexOf(
    'for service in "${application_services[@]}"',
  );
  assert.ok(recoveryServicesAt >= 0);
  assert.ok(recoveryRemovalAt > recoveryServicesAt);
  const recoveryServicesBlock = recoveryWorkflow.slice(
    recoveryServicesAt,
    recoveryRemovalAt,
  );
  assert.doesNotMatch(recoveryServicesBlock, /\bpostgres\b/);
  assert.doesNotMatch(recoveryServicesBlock, /\bredis\b/);
  assert.ok(
    recoveryWorkflow.includes(
      "label=com.docker.compose.project=hunch-monorepo",
    ),
  );
  assert.ok(
    recoveryWorkflow.includes('"${compose[@]}" up -d --no-build nginx'),
  );
});

console.log("[content-tests] passed");
