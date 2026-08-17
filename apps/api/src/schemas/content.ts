import { z } from "zod";

import {
  contentAuthorSchema,
  contentCategorySchema,
  contentDocumentSchema,
  contentImagePlacementSchema,
  contentSeoSchema,
  contentTagSchema,
} from "./content-blocks.js";

export const contentArticleStatusSchema = z.enum([
  "draft",
  "in_review",
  "approved",
  "published",
  "scheduled",
  "archived",
]);

export const contentEditorialStatusSchema = z.enum([
  "draft",
  "in_review",
  "approved",
]);

export const contentArticleKindSchema = z.enum([
  "guide",
  "news",
  "analysis",
  "research",
  "update",
]);

export const contentPrimaryIntentSchema = z.enum([
  "learn",
  "compare",
  "navigate",
  "trade",
  "news",
]);

export const contentEditorialReferenceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/),
    label: z.string().trim().min(1).max(200),
  })
  .strict();

const contentQueryClusterSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const contentSourceSchema = z
  .object({
    checkedAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
    publisher: z.string().trim().min(1).max(200),
    sourceType: z.enum([
      "primary",
      "official",
      "research",
      "reporting",
      "data",
    ]),
    title: z.string().trim().min(1).max(300),
    url: z
      .string()
      .trim()
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === "https:", {
        message: "Content sources must use HTTPS",
      }),
  })
  .strict();

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

const contentEditorialReferencesSchema = z
  .array(contentEditorialReferenceSchema)
  .max(30)
  .transform((references) => uniqueBy(references, ({ id }) => id));

export const contentEditorialGraphSchema = z
  .object({
    entities: contentEditorialReferencesSchema.default([]),
    markets: contentEditorialReferencesSchema.default([]),
    parentHubId: z.string().uuid().nullable().default(null),
    primaryIntent: contentPrimaryIntentSchema.default("learn"),
    queryCluster: contentQueryClusterSchema.nullable().default(null),
    sources: z
      .array(contentSourceSchema)
      .max(30)
      .transform((sources) => uniqueBy(sources, ({ url }) => url))
      .default([]),
    topics: contentEditorialReferencesSchema.default([]),
    venues: contentEditorialReferencesSchema.default([]),
  })
  .strict();

export const contentArticleSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const contentTagsSchema = z
  .array(contentTagSchema)
  .max(20)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((tag) => {
      if (seen.has(tag.slug)) return false;
      seen.add(tag.slug);
      return true;
    });
  });

const editableFields = {
  contentKind: contentArticleKindSchema,
  editorialGraph: contentEditorialGraphSchema,
  slug: contentArticleSlugSchema,
  title: z.string().trim().min(1).max(160),
  excerpt: z.string().trim().max(500),
  document: contentDocumentSchema,
  listCover: contentImagePlacementSchema.nullable(),
  heroImage: contentImagePlacementSchema.nullable(),
  socialImage: contentImagePlacementSchema.nullable(),
  seo: contentSeoSchema,
  author: contentAuthorSchema,
  category: contentCategorySchema.nullable(),
  tags: contentTagsSchema,
  locale: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  featured: z.boolean(),
} as const;

export const contentArticleCreateBodySchema = z
  .object({
    slug: editableFields.slug,
    title: editableFields.title,
    contentKind: editableFields.contentKind.optional(),
    editorialGraph: editableFields.editorialGraph.optional(),
    excerpt: editableFields.excerpt.optional(),
    document: editableFields.document.optional(),
    listCover: editableFields.listCover.optional(),
    heroImage: editableFields.heroImage.optional(),
    socialImage: editableFields.socialImage.optional(),
    seo: editableFields.seo.optional(),
    author: editableFields.author.optional(),
    category: editableFields.category.optional(),
    tags: editableFields.tags.optional(),
    locale: editableFields.locale.optional(),
    featured: editableFields.featured.optional(),
  })
  .strict();

export const contentArticleUpdateBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    contentKind: editableFields.contentKind.optional(),
    editorialGraph: editableFields.editorialGraph.optional(),
    slug: editableFields.slug.optional(),
    title: editableFields.title.optional(),
    excerpt: editableFields.excerpt.optional(),
    document: editableFields.document.optional(),
    listCover: editableFields.listCover.optional(),
    heroImage: editableFields.heroImage.optional(),
    socialImage: editableFields.socialImage.optional(),
    seo: editableFields.seo.optional(),
    author: editableFields.author.optional(),
    category: editableFields.category.optional(),
    tags: editableFields.tags.optional(),
    locale: editableFields.locale.optional(),
    featured: editableFields.featured.optional(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).some((key) => key !== "expectedRevision"),
    { message: "At least one article field is required" },
  );

export const contentArticlePublishBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    publishAt: z.string().datetime().optional(),
  })
  .strict();

export const contentArticleMutationBodySchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export const contentArticlePreviewTokenBodySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    ttlSeconds: z.number().int().min(60).max(3_600).default(600),
  })
  .strict();

export const contentArticlePreviewHeadersSchema = z.object({
  "x-hunch-content-preview-token": z.string().trim().min(32).max(2_048),
});

export const contentArticleIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const contentArticleVersionParamsSchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
});

export const contentArticleSlugParamsSchema = z.object({
  slug: contentArticleSlugSchema,
});

const contentCursorSchema = z.string().trim().min(1).max(1_024).optional();

export const publicContentArticlesQuerySchema = z.object({
  cursor: contentCursorSchema,
  kind: contentArticleKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  tag: contentArticleSlugSchema.max(48).optional(),
});

export const publicContentArticleIndexQuerySchema = z.object({
  cursor: contentCursorSchema,
  limit: z.coerce.number().int().min(1).max(1_000).default(1_000),
});

export const adminContentArticlesQuerySchema = z.object({
  cursor: contentCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().min(1).max(200).optional(),
  status: contentArticleStatusSchema.optional(),
});

export const contentArticleVersionsQuerySchema = z.object({
  cursor: contentCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const contentAssetKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "file",
]);

export const contentAssetStatusSchema = z.enum([
  "pending",
  "verifying",
  "ready",
  "failed",
  "deleted",
]);

const contentAssetCreditUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  }, "Only credential-free HTTP(S) credit URLs are allowed");

export const contentAssetCreateBodySchema = z
  .object({
    kind: contentAssetKindSchema,
    originalFilename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(255),
    expectedByteSize: z.number().int().positive().max(500_000_000),
    checksumSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/),
    defaultAlt: z.string().trim().max(500).nullable().optional(),
    defaultCaption: z.string().trim().max(2_000).nullable().optional(),
    creditName: z.string().trim().max(200).nullable().optional(),
    creditUrl: contentAssetCreditUrlSchema.nullable().optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384,
        "Asset metadata must not exceed 16 KB",
      )
      .optional(),
  })
  .strict();

export const contentAssetCompleteBodySchema = z
  .object({
    byteSize: z.number().int().positive().max(500_000_000),
    checksumSha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive().max(100_000).nullable().optional(),
    height: z.number().int().positive().max(100_000).nullable().optional(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(86_400_000)
      .nullable()
      .optional(),
  })
  .strict();

export const contentAssetSourceTypeSchema = z.enum([
  "app-screenshot",
  "telegram-screenshot",
  "generated-editorial",
]);

export const contentAssetUpdateBodySchema = z
  .object({
    defaultAlt: z.string().trim().max(500).nullable().optional(),
    defaultCaption: z.string().trim().max(2_000).nullable().optional(),
    creditName: z.string().trim().max(200).nullable().optional(),
    creditUrl: contentAssetCreditUrlSchema.nullable().optional(),
    focalX: z.number().min(0).max(1).nullable().optional(),
    focalY: z.number().min(0).max(1).nullable().optional(),
    sourceType: contentAssetSourceTypeSchema.optional(),
    license: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one asset field is required",
  });

export const contentAssetIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const journalServiceIdempotencyHeadersSchema = z
  .object({
    "idempotency-key": z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .passthrough();

export const journalServiceAssetCreateBodySchema = contentAssetCreateBodySchema
  .omit({ kind: true, metadata: true })
  .extend({
    sourceType: contentAssetSourceTypeSchema,
    license: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

export const journalServiceAssetUpdateBodySchema = contentAssetUpdateBodySchema;

export const journalServiceAssetsQuerySchema = z.object({
  cursor: contentCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: contentAssetStatusSchema.optional(),
});

export const adminContentAssetsQuerySchema = z.object({
  cursor: contentCursorSchema,
  limit: z.coerce.number().int().min(1).max(100).default(30),
  kind: contentAssetKindSchema.optional(),
  status: contentAssetStatusSchema.optional(),
});

export type ContentArticleCreateBody = z.infer<
  typeof contentArticleCreateBodySchema
>;
export type ContentArticleUpdateBody = z.infer<
  typeof contentArticleUpdateBodySchema
>;
export type ContentArticleStatus = z.infer<typeof contentArticleStatusSchema>;
export type ContentArticleKind = z.infer<typeof contentArticleKindSchema>;
export type ContentEditorialGraph = z.infer<typeof contentEditorialGraphSchema>;
export type ContentEditorialReference = z.infer<
  typeof contentEditorialReferenceSchema
>;
export type ContentPrimaryIntent = z.infer<typeof contentPrimaryIntentSchema>;
export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ContentEditorialStatus = z.infer<
  typeof contentEditorialStatusSchema
>;
export type ContentAssetCreateBody = z.infer<
  typeof contentAssetCreateBodySchema
>;
export type ContentAssetCompleteBody = z.infer<
  typeof contentAssetCompleteBodySchema
>;
export type ContentAssetSourceType = z.infer<
  typeof contentAssetSourceTypeSchema
>;
export type ContentAssetUpdateBody = z.infer<
  typeof contentAssetUpdateBodySchema
>;
export type JournalServiceAssetCreateBody = z.infer<
  typeof journalServiceAssetCreateBodySchema
>;
export type JournalServiceAssetUpdateBody = z.infer<
  typeof journalServiceAssetUpdateBodySchema
>;
