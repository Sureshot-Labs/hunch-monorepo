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
    creditUrl: z.string().trim().url().max(2_048).nullable().optional(),
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

export const contentAssetUpdateBodySchema = z
  .object({
    defaultAlt: z.string().trim().max(500).nullable().optional(),
    defaultCaption: z.string().trim().max(2_000).nullable().optional(),
    creditName: z.string().trim().max(200).nullable().optional(),
    creditUrl: z.string().trim().url().max(2_048).nullable().optional(),
    focalX: z.number().min(0).max(1).nullable().optional(),
    focalY: z.number().min(0).max(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one asset field is required",
  });

export const contentAssetIdParamsSchema = z.object({
  id: z.string().uuid(),
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
export type ContentEditorialStatus = z.infer<
  typeof contentEditorialStatusSchema
>;
export type ContentAssetCreateBody = z.infer<
  typeof contentAssetCreateBodySchema
>;
export type ContentAssetCompleteBody = z.infer<
  typeof contentAssetCompleteBodySchema
>;
export type ContentAssetUpdateBody = z.infer<
  typeof contentAssetUpdateBodySchema
>;
