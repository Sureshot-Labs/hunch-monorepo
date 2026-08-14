import type { Pool } from "@hunch/infra";
import { tx } from "@hunch/infra";

import type { DbQuery } from "../db.js";
import {
  CONTENT_DOCUMENT_SCHEMA_VERSION,
  contentAuthorSchema,
  contentCategorySchema,
  contentDocumentSchema,
  contentImagePlacementSchema,
  contentSeoSchema,
  contentTagSchema,
  type ContentAuthor,
  type ContentCategory,
  type ContentDocument,
  type ContentImagePlacement,
  type ContentSeo,
  type ContentTag,
} from "../schemas/content-blocks.js";
import {
  contentArticleCreateBodySchema,
  contentArticleUpdateBodySchema,
  type ContentArticleKind,
  type ContentArticleCreateBody,
  type ContentArticleStatus,
  type ContentArticleUpdateBody,
  contentEditorialGraphSchema,
  type ContentEditorialGraph,
  type ContentEditorialStatus,
} from "../schemas/content.js";
import {
  CONTENT_MAX_ASSET_REFERENCES,
  collectContentAssetReferences,
  contentPayloadHash,
  deriveContentDocument,
  validateContentDocumentForPublication,
  type ContentAssetReference,
  type ContentTocItem,
} from "./content-document.js";
import { ContentError } from "./content-errors.js";
import { promoteContentRoute } from "./content-routes.js";

export { ContentError } from "./content-errors.js";

type ArticleStateRow = {
  id: string;
  editorial_status: ContentEditorialStatus;
  published_version_id: string | null;
  scheduled_version_id: string | null;
  published_slug: string | null;
  published_tag_slugs: string[];
  published_featured: boolean;
  first_published_at: Date | string | null;
  published_at: Date | string | null;
  scheduled_for: Date | string | null;
  archived_at: Date | string | null;
  created_by_admin_id: string | null;
  updated_by_admin_id: string | null;
  published_by_admin_id: string | null;
  article_created_at: Date | string;
  article_updated_at: Date | string;
};

type DraftRow = {
  article_id: string;
  revision: number;
  schema_version: number;
  content_kind: ContentArticleKind;
  editorial_graph: unknown;
  slug: string;
  title: string;
  excerpt: string;
  document: unknown;
  list_cover: unknown;
  hero_image: unknown;
  social_image: unknown;
  seo: unknown;
  author: unknown;
  category: unknown;
  tags: unknown;
  tag_slugs: string[];
  locale: string;
  featured: boolean;
  plain_text: string;
  word_count: number;
  reading_time_minutes: number;
  toc: unknown;
  content_hash: string;
  updated_by_admin_id: string | null;
  draft_created_at: Date | string;
  draft_updated_at: Date | string;
};

type AdminArticleRow = ArticleStateRow &
  DraftRow & {
    published_content_hash: string | null;
  };

type VersionRow = {
  id: string;
  article_id: string;
  version_number: number;
  source_draft_revision: number;
  kind: ContentVersionKind;
  schema_version: number;
  content_kind: ContentArticleKind;
  editorial_graph: unknown;
  slug: string;
  title: string;
  excerpt: string;
  document: unknown;
  list_cover: unknown;
  hero_image: unknown;
  social_image: unknown;
  seo: unknown;
  author: unknown;
  category: unknown;
  tags: unknown;
  tag_slugs: string[];
  locale: string;
  featured: boolean;
  plain_text: string;
  word_count: number;
  reading_time_minutes: number;
  toc: unknown;
  content_hash: string;
  created_by_admin_id: string | null;
  created_at: Date | string;
};

type VersionSummaryRow = Pick<
  VersionRow,
  | "id"
  | "article_id"
  | "version_number"
  | "source_draft_revision"
  | "kind"
  | "title"
  | "slug"
  | "content_hash"
  | "created_by_admin_id"
  | "created_at"
>;

type VersionMutationRow = VersionSummaryRow & {
  tag_slugs: string[];
  featured: boolean;
};

const CONTENT_MAX_CHECKPOINTS_PER_ARTICLE = 100;

type ContentAssetRow = {
  id: string;
  status: "pending" | "verifying" | "ready" | "failed" | "deleted";
  kind: "image" | "video" | "audio" | "file";
  width: number | null;
  height: number | null;
};

export type ContentVersionKind = "checkpoint" | "published" | "scheduled";

export type ContentArticleDraft = {
  revision: number;
  schemaVersion: number;
  contentKind: ContentArticleKind;
  editorialGraph: ContentEditorialGraph;
  slug: string;
  title: string;
  excerpt: string;
  document: ContentDocument;
  listCover: ContentImagePlacement | null;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
  seo: ContentSeo;
  author: ContentAuthor;
  category: ContentCategory | null;
  tags: ContentTag[];
  locale: string;
  featured: boolean;
  plainText: string;
  wordCount: number;
  readingTimeMinutes: number;
  toc: ContentTocItem[];
  contentHash: string;
  updatedByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ContentArticle = {
  id: string;
  status: ContentArticleStatus;
  editorialStatus: ContentEditorialStatus;
  hasUnpublishedChanges: boolean;
  draft: ContentArticleDraft;
  published: {
    versionId: string;
    slug: string;
    firstPublishedAt: string;
    publishedAt: string;
  } | null;
  scheduled: { versionId: string; publishAt: string } | null;
  archivedAt: string | null;
  createdByAdminId: string | null;
  updatedByAdminId: string | null;
  publishedByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminContentArticleSummary = Omit<ContentArticle, "draft"> & {
  draft: Omit<ContentArticleDraft, "document" | "plainText" | "toc">;
};

export type ContentArticleVersionSummary = {
  id: string;
  articleId: string;
  versionNumber: number;
  sourceDraftRevision: number;
  kind: ContentVersionKind;
  title: string;
  slug: string;
  contentHash: string;
  createdByAdminId: string | null;
  createdAt: string;
};

export type ContentArticleVersion = ContentArticleVersionSummary & {
  snapshot: Omit<
    ContentArticleDraft,
    "revision" | "updatedByAdminId" | "createdAt" | "updatedAt"
  >;
};

export type PublicContentArticleSummary = {
  id: string;
  contentKind: ContentArticleKind;
  slug: string;
  title: string;
  excerpt: string;
  listCover: ContentImagePlacement | null;
  author: ContentAuthor;
  category: ContentCategory | null;
  tags: ContentTag[];
  locale: string;
  featured: boolean;
  readingTimeMinutes: number;
  firstPublishedAt: string;
  publishedAt: string;
  updatedAt: string;
};

export type ResolvedContentAsset = {
  id: string;
  status: ContentAssetRow["status"];
  kind: ContentAssetRow["kind"];
  publicUrl: string | null;
  mimeType: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  defaultAlt: string | null;
  defaultCaption: string | null;
  creditName: string | null;
  creditUrl: string | null;
  focalX: number | null;
  focalY: number | null;
};

export type PublicContentArticle = PublicContentArticleSummary & {
  versionId: string;
  schemaVersion: number;
  editorialGraph: ContentEditorialGraph;
  document: ContentDocument;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
  seo: ContentSeo;
  wordCount: number;
  toc: ContentTocItem[];
  assets: ResolvedContentAsset[];
  relatedArticles: PublicContentArticleSummary[];
};

export type PreviewContentArticle = {
  id: string;
  revision: number;
  schemaVersion: number;
  contentKind: ContentArticleKind;
  editorialGraph: ContentEditorialGraph;
  slug: string;
  title: string;
  excerpt: string;
  document: ContentDocument;
  listCover: ContentImagePlacement | null;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
  seo: ContentSeo;
  author: ContentAuthor;
  category: ContentCategory | null;
  tags: ContentTag[];
  locale: string;
  featured: boolean;
  wordCount: number;
  readingTimeMinutes: number;
  toc: ContentTocItem[];
  firstPublishedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  assets: ResolvedContentAsset[];
  relatedArticles: PublicContentArticleSummary[];
};

export type ContentArticleMutationResult = {
  article: ContentArticle;
  previousSlug: string | null;
  publicContentChanged: boolean;
};

type NormalizedDraft = {
  contentKind: ContentArticleKind;
  editorialGraph: ContentEditorialGraph;
  slug: string;
  title: string;
  excerpt: string;
  document: ContentDocument;
  listCover: ContentImagePlacement | null;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
  seo: ContentSeo;
  author: ContentAuthor;
  category: ContentCategory | null;
  tags: ContentTag[];
  locale: string;
  featured: boolean;
};

const EMPTY_DOCUMENT: ContentDocument = {
  schemaVersion: CONTENT_DOCUMENT_SCHEMA_VERSION,
  blocks: [],
};

function primaryIntentForKind(contentKind: ContentArticleKind) {
  return contentKind === "news" ? ("news" as const) : ("learn" as const);
}

function defaultEditorialGraph(
  slug: string,
  contentKind: ContentArticleKind,
): ContentEditorialGraph {
  return contentEditorialGraphSchema.parse({
    primaryIntent: primaryIntentForKind(contentKind),
    queryCluster: slug,
  });
}

const ARTICLE_STATE_COLUMNS = `
  a.id,
  a.editorial_status,
  a.published_version_id,
  a.scheduled_version_id,
  a.published_slug,
  a.published_tag_slugs,
  a.published_featured,
  a.first_published_at,
  a.published_at,
  a.scheduled_for,
  a.archived_at,
  a.created_by_admin_id,
  a.updated_by_admin_id,
  a.published_by_admin_id,
  a.created_at as article_created_at,
  a.updated_at as article_updated_at
`;

const DRAFT_COLUMNS = `
  d.article_id,
  d.revision,
  d.schema_version,
  d.content_kind,
  d.editorial_graph,
  d.slug,
  d.title,
  d.excerpt,
  d.document,
  d.list_cover,
  d.hero_image,
  d.social_image,
  d.seo,
  d.author,
  d.category,
  d.tags,
  d.tag_slugs,
  d.locale,
  d.featured,
  d.plain_text,
  d.word_count,
  d.reading_time_minutes,
  d.toc,
  d.content_hash,
  d.updated_by_admin_id,
  d.created_at as draft_created_at,
  d.updated_at as draft_updated_at
`;

const DRAFT_SUMMARY_COLUMNS = `
  d.article_id,
  d.revision,
  d.schema_version,
  d.content_kind,
  d.editorial_graph,
  d.slug,
  d.title,
  d.excerpt,
  '{"schemaVersion":1,"blocks":[]}'::jsonb as document,
  d.list_cover,
  d.hero_image,
  d.social_image,
  d.seo,
  d.author,
  d.category,
  d.tags,
  d.tag_slugs,
  d.locale,
  d.featured,
  ''::text as plain_text,
  d.word_count,
  d.reading_time_minutes,
  '[]'::jsonb as toc,
  d.content_hash,
  d.updated_by_admin_id,
  d.created_at as draft_created_at,
  d.updated_at as draft_updated_at
`;

const VERSION_COLUMNS = `
  v.id,
  v.article_id,
  v.version_number,
  v.source_draft_revision,
  v.kind,
  v.schema_version,
  v.content_kind,
  v.editorial_graph,
  v.slug,
  v.title,
  v.excerpt,
  v.document,
  v.list_cover,
  v.hero_image,
  v.social_image,
  v.seo,
  v.author,
  v.category,
  v.tags,
  v.tag_slugs,
  v.locale,
  v.featured,
  v.plain_text,
  v.word_count,
  v.reading_time_minutes,
  v.toc,
  v.content_hash,
  v.created_by_admin_id,
  v.created_at
`;

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function requiredIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseToc(value: unknown): ContentTocItem[] {
  if (!Array.isArray(value)) return [];
  return value as ContentTocItem[];
}

function snapshotFromRow(
  row: DraftRow | VersionRow,
): ContentArticleVersion["snapshot"] {
  return {
    schemaVersion: row.schema_version,
    contentKind: row.content_kind,
    editorialGraph: contentEditorialGraphSchema.parse(row.editorial_graph),
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    document: contentDocumentSchema.parse(row.document),
    listCover: row.list_cover
      ? contentImagePlacementSchema.parse(row.list_cover)
      : null,
    heroImage: row.hero_image
      ? contentImagePlacementSchema.parse(row.hero_image)
      : null,
    socialImage: row.social_image
      ? contentImagePlacementSchema.parse(row.social_image)
      : null,
    seo: contentSeoSchema.parse(row.seo),
    author: contentAuthorSchema.parse(row.author),
    category: row.category ? contentCategorySchema.parse(row.category) : null,
    tags: contentTagSchema.array().parse(row.tags),
    locale: row.locale,
    featured: row.featured,
    plainText: row.plain_text,
    wordCount: row.word_count,
    readingTimeMinutes: row.reading_time_minutes,
    toc: parseToc(row.toc),
    contentHash: row.content_hash,
  };
}

function draftFromRow(row: DraftRow): ContentArticleDraft {
  return {
    revision: row.revision,
    ...snapshotFromRow(row),
    updatedByAdminId: row.updated_by_admin_id,
    createdAt: requiredIso(row.draft_created_at),
    updatedAt: requiredIso(row.draft_updated_at),
  };
}

function articleStatus(row: ArticleStateRow): ContentArticleStatus {
  if (row.archived_at) return "archived";
  if (row.scheduled_version_id) return "scheduled";
  if (row.published_version_id) return "published";
  return row.editorial_status;
}

function articleFromRow(row: AdminArticleRow): ContentArticle {
  const draft = draftFromRow(row);
  const firstPublishedAt = iso(row.first_published_at);
  const publishedAt = iso(row.published_at);
  return {
    id: row.id,
    status: articleStatus(row),
    editorialStatus: row.editorial_status,
    hasUnpublishedChanges:
      !row.published_version_id ||
      row.published_content_hash !== draft.contentHash,
    draft,
    published:
      row.published_version_id &&
      row.published_slug &&
      firstPublishedAt &&
      publishedAt
        ? {
            versionId: row.published_version_id,
            slug: row.published_slug,
            firstPublishedAt,
            publishedAt,
          }
        : null,
    scheduled:
      row.scheduled_version_id && row.scheduled_for
        ? {
            versionId: row.scheduled_version_id,
            publishAt: requiredIso(row.scheduled_for),
          }
        : null,
    archivedAt: iso(row.archived_at),
    createdByAdminId: row.created_by_admin_id,
    updatedByAdminId: row.updated_by_admin_id,
    publishedByAdminId: row.published_by_admin_id,
    createdAt: requiredIso(row.article_created_at),
    updatedAt: draft.updatedAt,
  };
}

function articleSummary(article: ContentArticle): AdminContentArticleSummary {
  const {
    document: _document,
    plainText: _plainText,
    toc: _toc,
    ...draft
  } = article.draft;
  return { ...article, draft };
}

function normalizeCreate(body: ContentArticleCreateBody): NormalizedDraft {
  const parsed = contentArticleCreateBodySchema.parse(body);
  const contentKind = parsed.contentKind ?? "guide";
  return {
    contentKind,
    editorialGraph:
      parsed.editorialGraph ?? defaultEditorialGraph(parsed.slug, contentKind),
    slug: parsed.slug,
    title: parsed.title,
    excerpt: parsed.excerpt ?? "",
    document: parsed.document ?? EMPTY_DOCUMENT,
    listCover: parsed.listCover ?? null,
    heroImage: parsed.heroImage ?? null,
    socialImage: parsed.socialImage ?? null,
    seo: contentSeoSchema.parse(parsed.seo ?? {}),
    author: contentAuthorSchema.parse(parsed.author ?? { name: "Hunch" }),
    category: parsed.category ?? null,
    tags: parsed.tags ?? [],
    locale: parsed.locale ?? "en",
    featured: parsed.featured ?? false,
  };
}

function mergeDraft(
  existing: ContentArticleDraft,
  update: ContentArticleUpdateBody,
): NormalizedDraft {
  const parsed = contentArticleUpdateBodySchema.parse(update);
  const contentKind = parsed.contentKind ?? existing.contentKind;
  const slug = parsed.slug ?? existing.slug;
  const editorialGraph = parsed.editorialGraph
    ? parsed.editorialGraph
    : {
        ...existing.editorialGraph,
        primaryIntent:
          parsed.contentKind && parsed.contentKind !== existing.contentKind
            ? primaryIntentForKind(contentKind)
            : existing.editorialGraph.primaryIntent,
        queryCluster:
          parsed.slug && existing.editorialGraph.queryCluster === existing.slug
            ? slug
            : existing.editorialGraph.queryCluster,
      };
  return {
    contentKind,
    editorialGraph,
    slug,
    title: parsed.title ?? existing.title,
    excerpt: parsed.excerpt ?? existing.excerpt,
    document: parsed.document ?? existing.document,
    listCover:
      parsed.listCover === undefined ? existing.listCover : parsed.listCover,
    heroImage:
      parsed.heroImage === undefined ? existing.heroImage : parsed.heroImage,
    socialImage:
      parsed.socialImage === undefined
        ? existing.socialImage
        : parsed.socialImage,
    seo: parsed.seo ?? existing.seo,
    author: parsed.author ?? existing.author,
    category:
      parsed.category === undefined ? existing.category : parsed.category,
    tags: parsed.tags ?? existing.tags,
    locale: parsed.locale ?? existing.locale,
    featured: parsed.featured ?? existing.featured,
  };
}

function deriveDraft(input: NormalizedDraft) {
  const derived = deriveContentDocument(input.document);
  const contentHash = contentPayloadHash(input);
  return { ...derived, contentHash };
}

function tagSlugs(tags: ContentTag[]): string[] {
  return tags.map((tag) => tag.slug);
}

function encodeCursor(cursor: {
  kind: "admin" | "public" | "version" | "audit";
  at: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeContentCursor(
  raw: string,
  expectedKind: "admin" | "public" | "version" | "audit",
): { at: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.kind !== expectedKind ||
      typeof parsed.at !== "string" ||
      !Number.isFinite(new Date(parsed.at).getTime()) ||
      typeof parsed.id !== "string" ||
      (expectedKind === "audit"
        ? !/^[1-9][0-9]*$/.test(parsed.id)
        : !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            parsed.id,
          ))
    ) {
      throw new Error("invalid cursor payload");
    }
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new ContentError(
      "content_cursor_invalid",
      "Invalid content cursor",
      400,
    );
  }
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function slugConflict(): ContentError {
  return new ContentError(
    "content_slug_conflict",
    "Article slug is already reserved, current, or redirected",
    409,
  );
}

async function reserveDraftSlug(
  db: DbQuery,
  articleId: string,
  previousSlug: string | null,
  nextSlug: string,
): Promise<void> {
  const { rows } = await db.query<{ article_id: string; kind: string }>(
    "select article_id, kind from content_routes where slug = $1 for update",
    [nextSlug],
  );
  const claimed = rows[0];
  if (claimed && claimed.article_id !== articleId) throw slugConflict();

  if (previousSlug && previousSlug !== nextSlug) {
    await db.query(
      `delete from content_routes where slug = $1 and article_id = $2 and kind = 'reserved'`,
      [previousSlug, articleId],
    );
  }
  if (!claimed) {
    await db.query(
      "insert into content_routes (slug, article_id, kind) values ($1, $2, 'reserved')",
      [nextSlug, articleId],
    );
  }
}

async function getArticleRow(
  db: DbQuery,
  id: string,
  forUpdate = false,
): Promise<AdminArticleRow | null> {
  const { rows } = await db.query<AdminArticleRow>(
    `
      select
        ${ARTICLE_STATE_COLUMNS},
        ${DRAFT_COLUMNS},
        pv.content_hash as published_content_hash
      from content_articles a
      join content_article_drafts d on d.article_id = a.id
      left join content_article_versions pv on pv.id = a.published_version_id
      where a.id = $1
      ${forUpdate ? "for update of a, d" : ""}
    `,
    [id],
  );
  return rows[0] ?? null;
}

async function requireArticleForUpdate(
  db: DbQuery,
  id: string,
  expectedRevision: number,
): Promise<AdminArticleRow> {
  const row = await getArticleRow(db, id, true);
  if (!row) {
    throw new ContentError(
      "content_article_not_found",
      "Content article not found",
      404,
    );
  }
  if (row.revision !== expectedRevision) {
    throw new ContentError(
      "content_revision_conflict",
      "Article draft was changed by another editor",
      409,
    );
  }
  return row;
}

function expectedAssetKind(role: string): ContentAssetRow["kind"] | null {
  if (
    role === "list_cover" ||
    role === "hero_image" ||
    role === "social_image" ||
    role === "author_avatar" ||
    role === "body_image" ||
    role === "body_gallery" ||
    role === "body_comparison" ||
    role === "body_video_poster" ||
    role === "body_link_card"
  ) {
    return "image";
  }
  if (role === "body_video") return "video";
  if (role === "body_audio") return "audio";
  if (role === "body_video_captions" || role === "body_file") return "file";
  return null;
}

async function resolveContentAssets(
  db: DbQuery,
  assetIds: string[],
  readyOnly: boolean,
): Promise<ResolvedContentAsset[]> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    status: ContentAssetRow["status"];
    kind: ContentAssetRow["kind"];
    public_url: string | null;
    mime_type: string;
    byte_size: string | number | bigint | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    default_alt: string | null;
    default_caption: string | null;
    credit_name: string | null;
    credit_url: string | null;
    focal_x: string | number | null;
    focal_y: string | number | null;
  }>(
    `
      select
        id, status, kind, public_url, mime_type, byte_size, width, height,
        duration_ms, default_alt, default_caption, credit_name, credit_url,
        focal_x, focal_y
      from content_assets
      where id = any($1::uuid[])
        and status <> 'deleted'
        and ($2::boolean = false or status = 'ready')
      order by id
    `,
    [ids, readyOnly],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    kind: row.kind,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    defaultAlt: row.default_alt,
    defaultCaption: row.default_caption,
    creditName: row.credit_name,
    creditUrl: row.credit_url,
    focalX: row.focal_x == null ? null : Number(row.focal_x),
    focalY: row.focal_y == null ? null : Number(row.focal_y),
  }));
}

async function loadReferencedAssets(
  db: DbQuery,
  references: ContentAssetReference[],
): Promise<Map<string, ContentAssetRow>> {
  const ids = [...new Set(references.map((reference) => reference.assetId))];
  if (ids.length === 0) return new Map();
  if (references.length > CONTENT_MAX_ASSET_REFERENCES) {
    throw new ContentError(
      "content_document_too_complex",
      `An article may reference at most ${CONTENT_MAX_ASSET_REFERENCES} media assets`,
      422,
    );
  }
  const { rows } = await db.query<ContentAssetRow>(
    `
      select id, status, kind, width, height
      from content_assets
      where id = any($1::uuid[])
      for key share
    `,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ContentError(
      "content_asset_not_found",
      "One or more referenced assets do not exist",
      422,
      missing,
    );
  }
  const unavailable = rows
    .filter((row) => row.status === "deleted" || row.status === "failed")
    .map((row) => row.id);
  if (unavailable.length > 0) {
    throw new ContentError(
      "content_asset_not_ready",
      "One or more referenced assets are unavailable",
      422,
      unavailable,
    );
  }
  return byId;
}

async function syncDraftAssetUsages(
  db: DbQuery,
  articleId: string,
  references: ContentAssetReference[],
): Promise<void> {
  await loadReferencedAssets(db, references);
  const assetIds = references.map((reference) => reference.assetId);
  const roles = references.map((reference) => reference.role);
  const blockIds = references.map((reference) => reference.blockId);
  await db.query(
    `
      with incoming as materialized (
        select asset_id, role, block_id
        from unnest($2::uuid[], $3::text[], $4::uuid[])
          as item(asset_id, role, block_id)
      )
      delete from content_asset_usages usage
      where usage.article_id = $1
        and usage.scope = 'draft'
        and not exists (
          select 1
          from incoming
          where incoming.asset_id = usage.asset_id
            and incoming.role = usage.role
            and incoming.block_id is not distinct from usage.block_id
        )
    `,
    [articleId, assetIds, roles, blockIds],
  );
  await db.query(
    `
      insert into content_asset_usages (
        article_id, asset_id, scope, role, block_id
      )
      select $1, incoming.asset_id, 'draft', incoming.role, incoming.block_id
      from unnest($2::uuid[], $3::text[], $4::uuid[])
        as incoming(asset_id, role, block_id)
      where not exists (
        select 1
        from content_asset_usages usage
        where usage.article_id = $1
          and usage.scope = 'draft'
          and usage.asset_id = incoming.asset_id
          and usage.role = incoming.role
          and usage.block_id is not distinct from incoming.block_id
      )
      on conflict do nothing
    `,
    [articleId, assetIds, roles, blockIds],
  );
}

async function insertVersionAssetUsages(
  db: DbQuery,
  articleId: string,
  versionId: string,
  references: ContentAssetReference[],
  requireReady: boolean,
): Promise<void> {
  const assets = await loadReferencedAssets(db, references);
  const issues = publicationAssetIssues(references, assets, requireReady);
  if (issues.length > 0) {
    throw new ContentError(
      "content_asset_not_ready",
      "Referenced assets are not publishable",
      422,
      issues,
    );
  }
  if (references.length === 0) return;
  await db.query(
    `
      insert into content_asset_usages (
        article_id, version_id, asset_id, scope, role, block_id
      )
      select $1, $2, asset_id, 'version', role, block_id
      from unnest($3::uuid[], $4::text[], $5::uuid[])
        as item(asset_id, role, block_id)
      on conflict do nothing
    `,
    [
      articleId,
      versionId,
      references.map((reference) => reference.assetId),
      references.map((reference) => reference.role),
      references.map((reference) => reference.blockId),
    ],
  );
}

function publicationAssetIssues(
  references: ContentAssetReference[],
  assets: Map<string, ContentAssetRow>,
  requireReady = true,
): string[] {
  const issues: string[] = [];
  for (const reference of references) {
    const asset = assets.get(reference.assetId);
    if (!asset) continue;
    if (requireReady && asset.status !== "ready") {
      issues.push(`${reference.role} asset ${asset.id} is not ready`);
    }
    const expectedKind = expectedAssetKind(reference.role);
    if (requireReady && expectedKind && asset.kind !== expectedKind) {
      issues.push(
        `${reference.role} asset ${asset.id} must be ${expectedKind}`,
      );
    }
    if (
      requireReady &&
      reference.role === "social_image" &&
      (!asset.width || !asset.height)
    ) {
      issues.push(`social image asset ${asset.id} requires dimensions`);
    }
    if (
      requireReady &&
      reference.role === "social_image" &&
      asset.width &&
      asset.height &&
      (asset.width < 600 ||
        asset.height < 315 ||
        asset.width / asset.height < 1.7 ||
        asset.width / asset.height > 2.1)
    ) {
      issues.push(
        `social image asset ${asset.id} should be at least 600x315 with an approximately 1.91:1 ratio`,
      );
    }
  }
  return issues;
}

async function validateDraftAssetsForPublication(
  db: DbQuery,
  draft: ContentArticleDraft,
): Promise<void> {
  const references = draftAssetReferences(draft);
  const assets = await loadReferencedAssets(db, references);
  const issues = publicationAssetIssues(references, assets);
  if (issues.length > 0) {
    throw new ContentError(
      "content_asset_not_ready",
      "Referenced assets are not publishable",
      422,
      issues,
    );
  }
}

async function validateRelatedArticlesForPublication(
  db: DbQuery,
  articleId: string,
  document: ContentDocument,
): Promise<void> {
  const ids = [
    ...new Set(
      document.blocks.flatMap((block) =>
        block.type === "relatedArticles" ? block.data.articleIds : [],
      ),
    ),
  ];
  if (ids.length === 0) return;
  if (ids.includes(articleId)) {
    throw new ContentError(
      "content_article_not_publishable",
      "An article cannot recommend itself",
      422,
    );
  }
  const { rows } = await db.query<{ id: string }>(
    `
      select id
      from content_articles
      where id = any($1::uuid[])
        and published_version_id is not null
        and archived_at is null
    `,
    [ids],
  );
  const available = new Set(rows.map((row) => row.id));
  const unavailable = ids.filter((id) => !available.has(id));
  if (unavailable.length > 0) {
    throw new ContentError(
      "content_article_not_publishable",
      "Related articles must exist and be published",
      422,
      unavailable,
    );
  }
}

async function validateEditorialGraphForPublication(
  db: DbQuery,
  articleId: string,
  draft: ContentArticleDraft,
): Promise<void> {
  const editorialGraph =
    draft.editorialGraph ??
    defaultEditorialGraph(draft.slug, draft.contentKind);
  const { parentHubId, primaryIntent, queryCluster } = editorialGraph;
  if (parentHubId === articleId) {
    throw new ContentError(
      "content_article_not_publishable",
      "An article cannot be its own parent hub",
      422,
    );
  }
  if (parentHubId) {
    const { rows } = await db.query<{ id: string }>(
      `
        select id
        from content_articles
        where id = $1
          and published_version_id is not null
          and archived_at is null
        limit 1
      `,
      [parentHubId],
    );
    if (!rows[0]) {
      throw new ContentError(
        "content_article_not_publishable",
        "The parent hub must exist and be published",
        422,
      );
    }
  }
  if (!draft.seo.robots.index || !queryCluster) return;
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `content-editorial-owner:${primaryIntent}:${queryCluster}`,
  ]);
  const { rows } = await db.query<{ slug: string }>(
    `
      select version.slug
      from content_articles article
      join content_article_versions version
        on version.id in (
          article.published_version_id,
          article.scheduled_version_id
        )
      where article.id <> $1
        and article.archived_at is null
        and version.editorial_graph->>'primaryIntent' = $2
        and version.editorial_graph->>'queryCluster' = $3
        and coalesce(version.seo->'robots'->>'index', 'true')::boolean
      limit 1
    `,
    [articleId, primaryIntent, queryCluster],
  );
  if (rows[0]) {
    throw new ContentError(
      "content_article_not_publishable",
      "Another indexable article already owns this search intent and query cluster",
      422,
      [`/journal/${rows[0].slug}`],
    );
  }
}

function draftAssetReferences(draft: ContentArticleDraft | NormalizedDraft) {
  return collectContentAssetReferences({
    document: draft.document,
    listCover: draft.listCover,
    heroImage: draft.heroImage,
    socialImage: draft.socialImage,
    author: draft.author,
  });
}

function publishabilityIssues(draft: ContentArticleDraft): string[] {
  const issues: string[] = [];
  const editorialGraph =
    draft.editorialGraph ??
    defaultEditorialGraph(draft.slug, draft.contentKind);
  if (!draft.title.trim()) issues.push("title is required");
  if (!draft.excerpt.trim()) issues.push("excerpt is required");
  if (!draft.listCover) issues.push("list cover is required");
  if (draft.seo.robots.index && !editorialGraph.queryCluster)
    issues.push("indexable articles require a query cluster");
  if (draft.contentKind === "news" && editorialGraph.primaryIntent !== "news")
    issues.push("news articles require the news primary intent");
  if (
    draft.contentKind === "news" &&
    draft.seo.robots.index &&
    !draft.author.showByline
  )
    issues.push("indexable articles must show an author byline");
  if (
    draft.contentKind === "news" &&
    draft.seo.robots.index &&
    !draft.author.url
  )
    issues.push("indexable articles require an author profile URL");
  if (
    draft.contentKind === "news" &&
    draft.seo.robots.index &&
    !draft.author.bio?.trim()
  )
    issues.push("indexable articles require an author bio");
  if (draft.contentKind === "news" && !draft.socialImage)
    issues.push("news articles require a dedicated social image");
  if (
    draft.contentKind === "news" &&
    editorialGraph.sources.length === 0 &&
    !draft.document.blocks.some(
      (block) => block.type === "citation" || block.type === "references",
    )
  )
    issues.push("news articles require a citation or references block");
  issues.push(
    ...validateContentDocumentForPublication({
      document: draft.document,
      listCover: draft.listCover,
      heroImage: draft.heroImage,
      socialImage: draft.socialImage,
    }),
  );
  return issues;
}

export function validateArticlePublishability(article: ContentArticle): void {
  const issues = publishabilityIssues(article.draft);
  if (issues.length > 0) {
    throw new ContentError(
      "content_article_not_publishable",
      "Article is not ready to publish",
      422,
      issues,
    );
  }
}

async function insertDraft(
  db: DbQuery,
  articleId: string,
  draft: NormalizedDraft,
  actorAdminId: string | null,
): Promise<void> {
  const derived = deriveDraft(draft);
  await db.query(
    `
      insert into content_article_drafts (
        article_id, schema_version, content_kind, editorial_graph, slug, title,
        excerpt, document, list_cover, hero_image, social_image, seo, author,
        category, tags, tag_slugs, locale, featured, plain_text, word_count,
        reading_time_minutes, toc, content_hash, updated_by_admin_id
      ) values (
        $1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb,
        $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
        $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21,
        $22::jsonb, $23, $24
      )
    `,
    [
      articleId,
      draft.document.schemaVersion,
      draft.contentKind,
      json(draft.editorialGraph),
      draft.slug,
      draft.title,
      draft.excerpt,
      json(draft.document),
      draft.listCover ? json(draft.listCover) : null,
      draft.heroImage ? json(draft.heroImage) : null,
      draft.socialImage ? json(draft.socialImage) : null,
      json(draft.seo),
      json(draft.author),
      draft.category ? json(draft.category) : null,
      json(draft.tags),
      tagSlugs(draft.tags),
      draft.locale,
      draft.featured,
      derived.plainText,
      derived.wordCount,
      derived.readingTimeMinutes,
      json(derived.toc),
      derived.contentHash,
      actorAdminId,
    ],
  );
  await syncDraftAssetUsages(db, articleId, draftAssetReferences(draft));
}

export async function createContentArticle(
  pool: Pool,
  body: ContentArticleCreateBody,
  actorAdminId: string | null,
): Promise<ContentArticleMutationResult> {
  const draft = normalizeCreate(body);
  try {
    return await tx(pool, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `
          insert into content_articles (
            editorial_status, created_by_admin_id, updated_by_admin_id
          ) values ('draft', $1, $1)
          returning id
        `,
        [actorAdminId],
      );
      const id = rows[0].id;
      await reserveDraftSlug(db, id, null, draft.slug);
      await insertDraft(db, id, draft, actorAdminId);
      await insertContentAuditEvent(db, {
        action: "article.created",
        articleId: id,
        actorAdminId,
      });
      const created = await getArticleRow(db, id);
      if (!created)
        throw new Error("Created content article could not be loaded");
      return {
        article: articleFromRow(created),
        previousSlug: null,
        publicContentChanged: false,
      };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw slugConflict();
    throw error;
  }
}

export async function updateContentArticle(
  pool: Pool,
  id: string,
  body: ContentArticleUpdateBody,
  actorAdminId: string | null,
): Promise<ContentArticleMutationResult> {
  try {
    return await tx(pool, async (db) => {
      const existingRow = await requireArticleForUpdate(
        db,
        id,
        contentArticleUpdateBodySchema.parse(body).expectedRevision,
      );
      const existing = articleFromRow(existingRow);
      const next = mergeDraft(existing.draft, body);
      const derived = deriveDraft(next);
      if (derived.contentHash === existing.draft.contentHash) {
        return {
          article: existing,
          previousSlug: null,
          publicContentChanged: false,
        };
      }
      await reserveDraftSlug(db, id, existing.draft.slug, next.slug);
      const { rows } = await db.query<{ revision: number }>(
        `
          update content_article_drafts
          set
            revision = revision + 1,
            schema_version = $1,
            content_kind = $2,
            editorial_graph = $3::jsonb,
            slug = $4,
            title = $5,
            excerpt = $6,
            document = $7::jsonb,
            list_cover = $8::jsonb,
            hero_image = $9::jsonb,
            social_image = $10::jsonb,
            seo = $11::jsonb,
            author = $12::jsonb,
            category = $13::jsonb,
            tags = $14::jsonb,
            tag_slugs = $15,
            locale = $16,
            featured = $17,
            plain_text = $18,
            word_count = $19,
            reading_time_minutes = $20,
            toc = $21::jsonb,
            content_hash = $22,
            updated_by_admin_id = $23
          where article_id = $24 and revision = $25
          returning revision
        `,
        [
          next.document.schemaVersion,
          next.contentKind,
          json(next.editorialGraph),
          next.slug,
          next.title,
          next.excerpt,
          json(next.document),
          next.listCover ? json(next.listCover) : null,
          next.heroImage ? json(next.heroImage) : null,
          next.socialImage ? json(next.socialImage) : null,
          json(next.seo),
          json(next.author),
          next.category ? json(next.category) : null,
          json(next.tags),
          tagSlugs(next.tags),
          next.locale,
          next.featured,
          derived.plainText,
          derived.wordCount,
          derived.readingTimeMinutes,
          json(derived.toc),
          derived.contentHash,
          actorAdminId,
          id,
          existing.draft.revision,
        ],
      );
      if (!rows[0]) {
        throw new ContentError(
          "content_revision_conflict",
          "Article draft was changed by another editor",
          409,
        );
      }
      if (existing.editorialStatus !== "draft") {
        await db.query(
          `
            update content_articles
            set editorial_status = 'draft', updated_by_admin_id = $2
            where id = $1
          `,
          [id, actorAdminId],
        );
      }
      await syncDraftAssetUsages(db, id, draftAssetReferences(next));
      const updated = await getArticleRow(db, id);
      if (!updated)
        throw new Error("Updated content article could not be loaded");
      return {
        article: articleFromRow(updated),
        previousSlug:
          existing.draft.slug === next.slug ? null : existing.draft.slug,
        publicContentChanged: false,
      };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw slugConflict();
    throw error;
  }
}

export async function getAdminContentArticle(
  db: DbQuery,
  id: string,
): Promise<ContentArticle | null> {
  const row = await getArticleRow(db, id);
  return row ? articleFromRow(row) : null;
}

export async function listAdminContentArticles(
  db: DbQuery,
  inputs: {
    limit: number;
    cursor?: string;
    q?: string;
    status?: ContentArticleStatus;
  },
): Promise<{ items: AdminContentArticleSummary[]; nextCursor: string | null }> {
  const values: unknown[] = [];
  const where: string[] = [];
  let searchParameter: number | null = null;
  if (inputs.status === "archived") {
    where.push("a.archived_at is not null");
  } else {
    where.push("a.archived_at is null");
    if (inputs.status === "scheduled")
      where.push("a.scheduled_version_id is not null");
    if (inputs.status === "published") {
      where.push("a.scheduled_version_id is null");
      where.push("a.published_version_id is not null");
    }
    if (
      inputs.status === "draft" ||
      inputs.status === "in_review" ||
      inputs.status === "approved"
    ) {
      values.push(inputs.status);
      where.push(`a.scheduled_version_id is null`);
      where.push(`a.editorial_status = $${values.length}`);
    }
  }
  if (inputs.q) {
    values.push(inputs.q);
    searchParameter = values.length;
  }
  const cursor = inputs.cursor
    ? decodeContentCursor(inputs.cursor, "admin")
    : null;
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(
      `(d.updated_at, d.article_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(inputs.limit + 1);
  const { rows } = await db.query<AdminArticleRow>(
    `
      with
      ${
        searchParameter
          ? `search_matches as materialized (
              select article_id
              from content_article_drafts
              where search_document @@ websearch_to_tsquery('simple', $${searchParameter})
            ),`
          : ""
      }
      page as materialized (
        select d.article_id, d.updated_at
        from content_article_drafts d
        join content_articles a on a.id = d.article_id
        ${searchParameter ? "join search_matches sm on sm.article_id = d.article_id" : ""}
        where ${where.join(" and ")}
        order by d.updated_at desc, d.article_id desc
        limit $${values.length}
      )
      select
        ${ARTICLE_STATE_COLUMNS},
        ${DRAFT_SUMMARY_COLUMNS},
        pv.content_hash as published_content_hash
      from page
      join content_article_drafts d on d.article_id = page.article_id
      join content_articles a on a.id = d.article_id
      left join content_article_versions pv on pv.id = a.published_version_id
      order by page.updated_at desc, page.article_id desc
    `,
    values,
  );
  const hasMore = rows.length > inputs.limit;
  const items = rows
    .slice(0, inputs.limit)
    .map((row) => articleSummary(articleFromRow(row)));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ kind: "admin", at: last.updatedAt, id: last.id })
        : null,
  };
}

function versionSummary(row: VersionSummaryRow): ContentArticleVersionSummary {
  return {
    id: row.id,
    articleId: row.article_id,
    versionNumber: row.version_number,
    sourceDraftRevision: row.source_draft_revision,
    kind: row.kind,
    title: row.title,
    slug: row.slug,
    contentHash: row.content_hash,
    createdByAdminId: row.created_by_admin_id,
    createdAt: requiredIso(row.created_at),
  };
}

async function insertVersion(
  db: DbQuery,
  articleId: string,
  draft: ContentArticleDraft,
  kind: ContentVersionKind,
  actorAdminId: string | null,
): Promise<VersionMutationRow> {
  const { rows: numberRows } = await db.query<{ version_number: number }>(
    `select coalesce(max(version_number), 0) + 1 as version_number from content_article_versions where article_id = $1`,
    [articleId],
  );
  const versionNumber = numberRows[0].version_number;
  const { rows } = await db.query<VersionMutationRow>(
    `
      insert into content_article_versions (
        article_id, version_number, source_draft_revision, kind,
        schema_version, content_kind, editorial_graph, slug, title, excerpt,
        document, list_cover, hero_image, social_image, seo, author, category,
        tags, tag_slugs, locale, featured, plain_text, word_count,
        reading_time_minutes, toc, content_hash, created_by_admin_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb,
        $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
        $17::jsonb, $18::jsonb, $19, $20, $21, $22, $23, $24,
        $25::jsonb, $26, $27
      )
      returning
        id, article_id, version_number, source_draft_revision, kind,
        title, slug, content_hash, tag_slugs, featured,
        created_by_admin_id, created_at
    `,
    [
      articleId,
      versionNumber,
      draft.revision,
      kind,
      draft.schemaVersion,
      draft.contentKind,
      json(draft.editorialGraph),
      draft.slug,
      draft.title,
      draft.excerpt,
      json(draft.document),
      draft.listCover ? json(draft.listCover) : null,
      draft.heroImage ? json(draft.heroImage) : null,
      draft.socialImage ? json(draft.socialImage) : null,
      json(draft.seo),
      json(draft.author),
      draft.category ? json(draft.category) : null,
      json(draft.tags),
      tagSlugs(draft.tags),
      draft.locale,
      draft.featured,
      draft.plainText,
      draft.wordCount,
      draft.readingTimeMinutes,
      json(draft.toc),
      draft.contentHash,
      actorAdminId,
    ],
  );
  const version = rows[0];
  await insertVersionAssetUsages(
    db,
    articleId,
    version.id,
    draftAssetReferences(draft),
    kind !== "checkpoint",
  );
  return version;
}

async function insertOutbox(
  db: DbQuery,
  inputs: {
    eventType: string;
    articleId: string;
    versionId?: string | null;
    slug: string;
    previousSlug?: string | null;
    dedupeKey: string;
  },
) {
  await db.query(
    `
      insert into content_outbox (
        event_type, article_id, version_id, dedupe_key, payload
      ) values ($1, $2, $3, $4, $5::jsonb)
      on conflict (dedupe_key) do nothing
    `,
    [
      inputs.eventType,
      inputs.articleId,
      inputs.versionId ?? null,
      inputs.dedupeKey,
      json({
        event: inputs.eventType,
        articleId: inputs.articleId,
        versionId: inputs.versionId ?? null,
        slug: inputs.slug,
        previousSlug: inputs.previousSlug ?? null,
        occurredAt: new Date().toISOString(),
      }),
    ],
  );
}

async function insertContentAuditEvent(
  db: DbQuery,
  inputs: {
    action: string;
    articleId: string;
    actorAdminId: string | null;
    versionId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `
      insert into content_audit_events (
        action, article_id, version_id, actor_admin_id, metadata
      ) values ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      inputs.action,
      inputs.articleId,
      inputs.versionId ?? null,
      inputs.actorAdminId,
      json(inputs.metadata ?? {}),
    ],
  );
}

async function cancelScheduledPublication(db: DbQuery, articleId: string) {
  await db.query(
    `
      update content_publication_jobs
      set status = 'cancelled', completed_at = now(), locked_at = null, locked_by = null
      where article_id = $1 and status in ('pending', 'processing')
    `,
    [articleId],
  );
}

export async function createContentArticleCheckpoint(
  pool: Pool,
  inputs: { id: string; expectedRevision: number; actorAdminId: string | null },
): Promise<ContentArticleVersionSummary> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const draft = draftFromRow(row);
    const { rows: existingRows } = await db.query<VersionSummaryRow>(
      `
        select
          v.id, v.article_id, v.version_number, v.source_draft_revision,
          v.kind, v.title, v.slug, v.content_hash,
          v.created_by_admin_id, v.created_at
        from content_article_versions v
        where v.article_id = $1 and v.kind = 'checkpoint'
        order by v.created_at desc, v.id desc
        limit 1
      `,
      [inputs.id],
    );
    const existing = existingRows[0];
    if (existing?.content_hash === draft.contentHash) {
      return versionSummary(existing);
    }
    const checkpoint = await insertVersion(
      db,
      inputs.id,
      draft,
      "checkpoint",
      inputs.actorAdminId,
    );
    await insertContentAuditEvent(db, {
      action: "article.checkpoint_created",
      articleId: inputs.id,
      versionId: checkpoint.id,
      actorAdminId: inputs.actorAdminId,
    });
    await db.query(
      `
        delete from content_article_versions
        where id in (
          select id
          from content_article_versions
          where article_id = $1 and kind = 'checkpoint'
          order by created_at desc, id desc
          offset $2
        )
      `,
      [inputs.id, CONTENT_MAX_CHECKPOINTS_PER_ARTICLE],
    );
    return versionSummary(checkpoint);
  });
}

export async function publishContentArticle(
  pool: Pool,
  inputs: {
    id: string;
    expectedRevision: number;
    actorAdminId: string | null;
    publishAt?: Date;
    requireApproval?: boolean;
  },
): Promise<ContentArticleMutationResult> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const existing = articleFromRow(row);
    if (
      (inputs.requireApproval ?? true) &&
      existing.editorialStatus !== "approved"
    ) {
      throw new ContentError(
        "content_article_not_publishable",
        "Article must be approved before it can be published",
        409,
      );
    }
    validateArticlePublishability(existing);
    await validateDraftAssetsForPublication(db, existing.draft);
    await validateRelatedArticlesForPublication(
      db,
      inputs.id,
      existing.draft.document,
    );
    await validateEditorialGraphForPublication(db, inputs.id, existing.draft);
    const requestedAt = inputs.publishAt ?? new Date();
    const scheduled = requestedAt.getTime() > Date.now() + 5_000;
    if (
      !scheduled &&
      !existing.archivedAt &&
      existing.published &&
      !existing.hasUnpublishedChanges
    ) {
      return {
        article: existing,
        previousSlug: null,
        publicContentChanged: false,
      };
    }
    const version = await insertVersion(
      db,
      inputs.id,
      existing.draft,
      scheduled ? "scheduled" : "published",
      inputs.actorAdminId,
    );
    await cancelScheduledPublication(db, inputs.id);
    let previousSlug: string | null = null;
    if (scheduled) {
      await db.query(
        `
          update content_articles
          set
            editorial_status = 'approved',
            scheduled_version_id = $2,
            scheduled_for = $3,
            archived_at = null,
            updated_by_admin_id = $4
          where id = $1
        `,
        [inputs.id, version.id, requestedAt, inputs.actorAdminId],
      );
      await db.query(
        `
          insert into content_publication_jobs (
            article_id, version_id, status, run_at
          ) values ($1, $2, 'pending', $3)
        `,
        [inputs.id, version.id, requestedAt],
      );
    } else {
      previousSlug = await promoteContentRoute(
        db,
        inputs.id,
        version.slug,
        slugConflict,
      );
      const now = new Date();
      await db.query(
        `
          update content_articles
          set
            editorial_status = 'approved',
            published_version_id = $2,
            scheduled_version_id = null,
            scheduled_for = null,
            published_slug = $3,
            published_tag_slugs = $4,
            published_featured = $5,
            first_published_at = coalesce(first_published_at, $6),
            published_at = $6,
            archived_at = null,
            updated_by_admin_id = $7,
            published_by_admin_id = $7
          where id = $1
        `,
        [
          inputs.id,
          version.id,
          version.slug,
          version.tag_slugs,
          version.featured,
          now,
          inputs.actorAdminId,
        ],
      );
      await insertOutbox(db, {
        eventType: existing.published ? "article_updated" : "article_published",
        articleId: inputs.id,
        versionId: version.id,
        slug: version.slug,
        previousSlug,
        dedupeKey: `publish:${version.id}`,
      });
    }
    await insertContentAuditEvent(db, {
      action: scheduled ? "article.scheduled" : "article.published",
      articleId: inputs.id,
      versionId: version.id,
      actorAdminId: inputs.actorAdminId,
      metadata: scheduled
        ? { publishAt: requestedAt.toISOString() }
        : { previousSlug },
    });
    await db.query(
      "update content_article_drafts set revision = revision + 1 where article_id = $1",
      [inputs.id],
    );
    const updated = await getArticleRow(db, inputs.id);
    if (!updated)
      throw new Error("Published content article could not be loaded");
    return {
      article: articleFromRow(updated),
      previousSlug,
      publicContentChanged: !scheduled,
    };
  });
}

export async function cancelContentArticleSchedule(
  pool: Pool,
  inputs: { id: string; expectedRevision: number; actorAdminId: string | null },
): Promise<ContentArticleMutationResult> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const existing = articleFromRow(row);
    if (!existing.scheduled) {
      return {
        article: existing,
        previousSlug: null,
        publicContentChanged: false,
      };
    }
    await cancelScheduledPublication(db, inputs.id);
    await db.query(
      `
        update content_articles
        set scheduled_version_id = null, scheduled_for = null,
            updated_by_admin_id = $2
        where id = $1
      `,
      [inputs.id, inputs.actorAdminId],
    );
    await db.query(
      "update content_article_drafts set revision = revision + 1 where article_id = $1",
      [inputs.id],
    );
    await insertContentAuditEvent(db, {
      action: "article.schedule_cancelled",
      articleId: inputs.id,
      versionId: existing.scheduled.versionId,
      actorAdminId: inputs.actorAdminId,
    });
    const updated = await getArticleRow(db, inputs.id);
    if (!updated) throw new Error("Content article could not be loaded");
    return {
      article: articleFromRow(updated),
      previousSlug: null,
      publicContentChanged: false,
    };
  });
}

export async function unpublishContentArticle(
  pool: Pool,
  inputs: { id: string; expectedRevision: number; actorAdminId: string | null },
): Promise<ContentArticleMutationResult> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const existing = articleFromRow(row);
    if (!existing.published && !existing.scheduled) {
      return {
        article: existing,
        previousSlug: null,
        publicContentChanged: false,
      };
    }
    await cancelScheduledPublication(db, inputs.id);
    if (existing.published?.slug) {
      await db.query(
        `update content_routes set kind = 'reserved' where article_id = $1 and kind = 'current'`,
        [inputs.id],
      );
    }
    await db.query(
      `
        update content_articles
        set
          editorial_status = 'draft',
          published_version_id = null,
          scheduled_version_id = null,
          published_slug = null,
          published_tag_slugs = '{}',
          published_featured = false,
          published_at = null,
          scheduled_for = null,
          updated_by_admin_id = $2
        where id = $1
      `,
      [inputs.id, inputs.actorAdminId],
    );
    if (existing.published) {
      await insertOutbox(db, {
        eventType: "article_unpublished",
        articleId: inputs.id,
        slug: existing.published.slug,
        dedupeKey: `unpublish:${inputs.id}:${existing.published.versionId}`,
      });
    }
    await insertContentAuditEvent(db, {
      action: "article.unpublished",
      articleId: inputs.id,
      versionId: existing.published?.versionId ?? existing.scheduled?.versionId,
      actorAdminId: inputs.actorAdminId,
    });
    await db.query(
      "update content_article_drafts set revision = revision + 1 where article_id = $1",
      [inputs.id],
    );
    const updated = await getArticleRow(db, inputs.id);
    if (!updated) throw new Error("Unpublished article could not be loaded");
    return {
      article: articleFromRow(updated),
      previousSlug: null,
      publicContentChanged: Boolean(existing.published),
    };
  });
}

export async function archiveContentArticle(
  pool: Pool,
  inputs: { id: string; expectedRevision: number; actorAdminId: string | null },
): Promise<ContentArticleMutationResult> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const existing = articleFromRow(row);
    if (existing.archivedAt) {
      return {
        article: existing,
        previousSlug: null,
        publicContentChanged: false,
      };
    }
    await cancelScheduledPublication(db, inputs.id);
    await db.query(
      `
        update content_articles
        set archived_at = now(), scheduled_version_id = null,
            scheduled_for = null, updated_by_admin_id = $2
        where id = $1
      `,
      [inputs.id, inputs.actorAdminId],
    );
    if (existing.published) {
      await insertOutbox(db, {
        eventType: "article_archived",
        articleId: inputs.id,
        versionId: existing.published.versionId,
        slug: existing.published.slug,
        dedupeKey: `archive:${inputs.id}:${existing.published.versionId}`,
      });
    }
    await insertContentAuditEvent(db, {
      action: "article.archived",
      articleId: inputs.id,
      versionId: existing.published?.versionId ?? null,
      actorAdminId: inputs.actorAdminId,
    });
    await db.query(
      "update content_article_drafts set revision = revision + 1 where article_id = $1",
      [inputs.id],
    );
    const updated = await getArticleRow(db, inputs.id);
    if (!updated) throw new Error("Archived article could not be loaded");
    return {
      article: articleFromRow(updated),
      previousSlug: null,
      publicContentChanged: Boolean(existing.published),
    };
  });
}

export async function transitionContentArticleReview(
  pool: Pool,
  inputs: {
    id: string;
    expectedRevision: number;
    actorAdminId: string | null;
    status: ContentEditorialStatus;
  },
): Promise<ContentArticle> {
  return tx(pool, async (db) => {
    const row = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const article = articleFromRow(row);
    if (article.archivedAt) {
      throw new ContentError(
        "content_article_not_publishable",
        "Restore or publish an archived article before changing review state",
        409,
      );
    }
    if (article.editorialStatus === inputs.status) return article;
    if (inputs.status === "approved") {
      validateArticlePublishability(article);
      await validateDraftAssetsForPublication(db, article.draft);
      await validateRelatedArticlesForPublication(
        db,
        inputs.id,
        article.draft.document,
      );
      await validateEditorialGraphForPublication(db, inputs.id, article.draft);
    }
    await db.query(
      `
        update content_articles
        set editorial_status = $2, updated_by_admin_id = $3
        where id = $1
      `,
      [inputs.id, inputs.status, inputs.actorAdminId],
    );
    await db.query(
      "update content_article_drafts set revision = revision + 1 where article_id = $1",
      [inputs.id],
    );
    await insertContentAuditEvent(db, {
      action: `article.review_${inputs.status}`,
      articleId: inputs.id,
      actorAdminId: inputs.actorAdminId,
    });
    const updated = await getArticleRow(db, inputs.id);
    if (!updated) throw new Error("Transitioned article could not be loaded");
    return articleFromRow(updated);
  });
}

export async function listContentArticleVersions(
  db: DbQuery,
  inputs: { articleId: string; limit: number; cursor?: string },
): Promise<{
  items: ContentArticleVersionSummary[];
  nextCursor: string | null;
}> {
  const cursor = inputs.cursor
    ? decodeContentCursor(inputs.cursor, "version")
    : null;
  const { rows } = await db.query<VersionSummaryRow>(
    `
      select
        v.id, v.article_id, v.version_number, v.source_draft_revision,
        v.kind, v.title, v.slug, v.content_hash,
        v.created_by_admin_id, v.created_at
      from content_article_versions v
      where v.article_id = $1
        and (
          $2::timestamptz is null
          or (v.created_at, v.id) < ($2::timestamptz, $3::uuid)
        )
      order by v.created_at desc, v.id desc
      limit $4
    `,
    [
      inputs.articleId,
      cursor?.at ?? null,
      cursor?.id ?? null,
      inputs.limit + 1,
    ],
  );
  const hasMore = rows.length > inputs.limit;
  const items = rows.slice(0, inputs.limit).map(versionSummary);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ kind: "version", at: last.createdAt, id: last.id })
        : null,
  };
}

export async function getContentArticleVersion(
  db: DbQuery,
  articleId: string,
  versionId: string,
): Promise<ContentArticleVersion | null> {
  const { rows } = await db.query<VersionRow>(
    `
      select ${VERSION_COLUMNS}
      from content_article_versions v
      where v.article_id = $1 and v.id = $2
      limit 1
    `,
    [articleId, versionId],
  );
  const row = rows[0];
  return row
    ? { ...versionSummary(row), snapshot: snapshotFromRow(row) }
    : null;
}

export type ContentAuditEvent = {
  id: string;
  action: string;
  articleId: string | null;
  assetId: string | null;
  versionId: string | null;
  actorAdminId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function listContentArticleAudit(
  db: DbQuery,
  inputs: { articleId: string; limit: number; cursor?: string },
): Promise<{ items: ContentAuditEvent[]; nextCursor: string | null }> {
  const cursor = inputs.cursor
    ? decodeContentCursor(inputs.cursor, "audit")
    : null;
  const { rows } = await db.query<{
    id: string | number | bigint;
    action: string;
    article_id: string | null;
    asset_id: string | null;
    version_id: string | null;
    actor_admin_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `
      select
        id, action, article_id, asset_id, version_id, actor_admin_id,
        metadata, created_at
      from content_audit_events
      where article_id = $1
        and (
          $2::timestamptz is null
          or (created_at, id) < ($2::timestamptz, $3::bigint)
        )
      order by created_at desc, id desc
      limit $4
    `,
    [
      inputs.articleId,
      cursor?.at ?? null,
      cursor?.id ?? null,
      inputs.limit + 1,
    ],
  );
  const selected = rows.slice(0, inputs.limit);
  const items = selected.map((row) => ({
    id: String(row.id),
    action: row.action,
    articleId: row.article_id,
    assetId: row.asset_id,
    versionId: row.version_id,
    actorAdminId: row.actor_admin_id,
    metadata: row.metadata,
    createdAt: requiredIso(row.created_at),
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > inputs.limit && last
        ? encodeCursor({ kind: "audit", at: last.createdAt, id: last.id })
        : null,
  };
}

export async function restoreContentArticleVersion(
  pool: Pool,
  inputs: {
    id: string;
    versionId: string;
    expectedRevision: number;
    actorAdminId: string | null;
  },
): Promise<ContentArticleMutationResult> {
  return tx(pool, async (db) => {
    const currentRow = await requireArticleForUpdate(
      db,
      inputs.id,
      inputs.expectedRevision,
    );
    const current = articleFromRow(currentRow);
    const { rows } = await db.query<VersionRow>(
      `
        select ${VERSION_COLUMNS}
        from content_article_versions v
        where v.article_id = $1 and v.id = $2
        limit 1
      `,
      [inputs.id, inputs.versionId],
    );
    const version = rows[0];
    if (!version) {
      throw new ContentError(
        "content_version_not_found",
        "Content version not found",
        404,
      );
    }
    const snapshot = snapshotFromRow(version);
    await reserveDraftSlug(db, inputs.id, current.draft.slug, snapshot.slug);
    await db.query(
      `
        update content_article_drafts
        set
          revision = revision + 1,
          schema_version = $2,
          content_kind = $3,
          editorial_graph = $4::jsonb,
          slug = $5,
          title = $6,
          excerpt = $7,
          document = $8::jsonb,
          list_cover = $9::jsonb,
          hero_image = $10::jsonb,
          social_image = $11::jsonb,
          seo = $12::jsonb,
          author = $13::jsonb,
          category = $14::jsonb,
          tags = $15::jsonb,
          tag_slugs = $16,
          locale = $17,
          featured = $18,
          plain_text = $19,
          word_count = $20,
          reading_time_minutes = $21,
          toc = $22::jsonb,
          content_hash = $23,
          updated_by_admin_id = $24
        where article_id = $1 and revision = $25
      `,
      [
        inputs.id,
        snapshot.schemaVersion,
        snapshot.contentKind,
        json(snapshot.editorialGraph),
        snapshot.slug,
        snapshot.title,
        snapshot.excerpt,
        json(snapshot.document),
        snapshot.listCover ? json(snapshot.listCover) : null,
        snapshot.heroImage ? json(snapshot.heroImage) : null,
        snapshot.socialImage ? json(snapshot.socialImage) : null,
        json(snapshot.seo),
        json(snapshot.author),
        snapshot.category ? json(snapshot.category) : null,
        json(snapshot.tags),
        tagSlugs(snapshot.tags),
        snapshot.locale,
        snapshot.featured,
        snapshot.plainText,
        snapshot.wordCount,
        snapshot.readingTimeMinutes,
        json(snapshot.toc),
        snapshot.contentHash,
        inputs.actorAdminId,
        inputs.expectedRevision,
      ],
    );
    if (current.archivedAt) {
      await db.query(
        `
          update content_articles
          set
            editorial_status = 'draft',
            archived_at = null,
            published_version_id = null,
            scheduled_version_id = null,
            published_slug = null,
            published_tag_slugs = '{}',
            published_featured = false,
            published_at = null,
            scheduled_for = null,
            updated_by_admin_id = $2
          where id = $1
        `,
        [inputs.id, inputs.actorAdminId],
      );
      await db.query(
        `update content_routes set kind = 'reserved' where article_id = $1 and kind = 'current'`,
        [inputs.id],
      );
    } else {
      await db.query(
        `update content_articles set editorial_status = 'draft', updated_by_admin_id = $2 where id = $1`,
        [inputs.id, inputs.actorAdminId],
      );
    }
    await syncDraftAssetUsages(db, inputs.id, draftAssetReferences(snapshot));
    await insertContentAuditEvent(db, {
      action: "article.version_restored",
      articleId: inputs.id,
      versionId: inputs.versionId,
      actorAdminId: inputs.actorAdminId,
    });
    const updated = await getArticleRow(db, inputs.id);
    if (!updated) throw new Error("Restored article could not be loaded");
    return {
      article: articleFromRow(updated),
      previousSlug:
        current.draft.slug === snapshot.slug ? null : current.draft.slug,
      publicContentChanged: false,
    };
  });
}

export async function getPreviewContentArticle(
  db: DbQuery,
  articleId: string,
  expectedRevision: number,
): Promise<PreviewContentArticle | null> {
  const row = await getArticleRow(db, articleId);
  if (!row) return null;
  const article = articleFromRow(row);
  if (article.draft.revision !== expectedRevision) {
    throw new ContentError(
      "content_preview_expired",
      "The article changed after this preview was created",
      410,
    );
  }
  const draft = article.draft;
  const relatedArticles = await loadRelatedPublicArticles(
    db,
    draft.document,
    article.id,
  );
  const assets = await resolveContentAssets(
    db,
    [
      ...draftAssetReferences(draft).map((reference) => reference.assetId),
      ...relatedArticles.flatMap((related) =>
        related.listCover ? [related.listCover.assetId] : [],
      ),
    ],
    false,
  );
  return {
    id: article.id,
    revision: draft.revision,
    schemaVersion: draft.schemaVersion,
    contentKind: draft.contentKind,
    editorialGraph: draft.editorialGraph,
    slug: draft.slug,
    title: draft.title,
    excerpt: draft.excerpt,
    document: draft.document,
    listCover: draft.listCover,
    heroImage: draft.heroImage,
    socialImage: draft.socialImage,
    seo: draft.seo,
    author: draft.author,
    category: draft.category,
    tags: draft.tags,
    locale: draft.locale,
    featured: draft.featured,
    wordCount: draft.wordCount,
    readingTimeMinutes: draft.readingTimeMinutes,
    toc: draft.toc,
    firstPublishedAt: article.published?.firstPublishedAt ?? null,
    publishedAt: article.published?.publishedAt ?? null,
    updatedAt: draft.updatedAt,
    assets,
    relatedArticles,
  };
}

type PublicSummaryRow = {
  id: string;
  version_id: string;
  content_kind: ContentArticleKind;
  slug: string;
  title: string;
  excerpt: string;
  list_cover: unknown;
  author: unknown;
  category: unknown;
  tags: unknown;
  locale: string;
  featured: boolean;
  reading_time_minutes: number;
  first_published_at: Date | string;
  published_at: Date | string;
  version_created_at: Date | string;
};

function publicSummary(row: PublicSummaryRow): PublicContentArticleSummary {
  return {
    id: row.id,
    contentKind: row.content_kind,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    listCover: row.list_cover
      ? contentImagePlacementSchema.parse(row.list_cover)
      : null,
    author: contentAuthorSchema.parse(row.author),
    category: row.category ? contentCategorySchema.parse(row.category) : null,
    tags: contentTagSchema.array().parse(row.tags),
    locale: row.locale,
    featured: row.featured,
    readingTimeMinutes: row.reading_time_minutes,
    firstPublishedAt: requiredIso(row.first_published_at),
    publishedAt: requiredIso(row.published_at),
    updatedAt: requiredIso(row.version_created_at),
  };
}

function relatedArticleIds(document: ContentDocument): string[] {
  const ids = document.blocks.flatMap((block) =>
    block.type === "relatedArticles" ? block.data.articleIds : [],
  );
  return [...new Set(ids)].slice(0, 12);
}

async function loadRelatedPublicArticles(
  db: DbQuery,
  document: ContentDocument,
  currentArticleId: string,
): Promise<PublicContentArticleSummary[]> {
  const ids = relatedArticleIds(document).filter(
    (articleId) => articleId !== currentArticleId,
  );
  if (ids.length === 0) return [];
  const { rows } = await db.query<PublicSummaryRow>(
    `
      select
        a.id,
        v.id as version_id,
        v.content_kind,
        v.slug,
        v.title,
        v.excerpt,
        v.list_cover,
        v.author,
        v.category,
        v.tags,
        v.locale,
        v.featured,
        v.reading_time_minutes,
        a.first_published_at,
        a.published_at,
        greatest(v.created_at, a.published_at) as version_created_at
      from content_articles a
      join content_article_versions v on v.id = a.published_version_id
      where a.id = any($1::uuid[])
        and a.published_version_id is not null
        and a.archived_at is null
    `,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, publicSummary(row)]));
  return ids.flatMap((id) => {
    const article = byId.get(id);
    return article ? [article] : [];
  });
}

export async function listPublicContentArticles(
  db: DbQuery,
  inputs: {
    limit: number;
    cursor?: string;
    tag?: string;
    kind?: ContentArticleKind;
  },
): Promise<{
  items: PublicContentArticleSummary[];
  nextCursor: string | null;
  assets: ResolvedContentAsset[];
}> {
  const values: unknown[] = [];
  const where = ["a.published_version_id is not null", "a.archived_at is null"];
  if (inputs.tag) {
    values.push([inputs.tag]);
    where.push(`a.published_tag_slugs @> $${values.length}::text[]`);
  }
  if (inputs.kind) {
    values.push(inputs.kind);
    where.push(`pv.content_kind = $${values.length}`);
  }
  const cursor = inputs.cursor
    ? decodeContentCursor(inputs.cursor, "public")
    : null;
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(
      `(a.published_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(inputs.limit + 1);
  const { rows } = await db.query<PublicSummaryRow>(
    `
      with page as materialized (
        select a.id, a.published_version_id, a.first_published_at, a.published_at
        from content_articles a
        join content_article_versions pv on pv.id = a.published_version_id
        where ${where.join(" and ")}
        order by a.published_at desc, a.id desc
        limit $${values.length}
      )
      select
        page.id,
        v.id as version_id,
        v.content_kind,
        v.slug,
        v.title,
        v.excerpt,
        v.list_cover,
        v.author,
        v.category,
        v.tags,
        v.locale,
        v.featured,
        v.reading_time_minutes,
        page.first_published_at,
        page.published_at,
        greatest(v.created_at, page.published_at) as version_created_at
      from page
      join content_article_versions v on v.id = page.published_version_id
      order by page.published_at desc, page.id desc
    `,
    values,
  );
  const hasMore = rows.length > inputs.limit;
  const selectedRows = rows.slice(0, inputs.limit);
  const items = selectedRows.map(publicSummary);
  const assets = await resolveContentAssets(
    db,
    items.flatMap((item) => (item.listCover ? [item.listCover.assetId] : [])),
    true,
  );
  const lastRow = selectedRows.at(-1);
  return {
    items,
    nextCursor:
      hasMore && lastRow
        ? encodeCursor({
            kind: "public",
            at: requiredIso(lastRow.published_at),
            id: lastRow.id,
          })
        : null,
    assets,
  };
}

type PublicDetailRow = PublicSummaryRow & {
  route_kind: "current" | "redirect";
  current_slug: string;
  schema_version: number;
  editorial_graph: unknown;
  document: unknown;
  hero_image: unknown;
  social_image: unknown;
  seo: unknown;
  word_count: number;
  toc: unknown;
};

export async function getPublicContentArticle(
  db: DbQuery,
  slug: string,
): Promise<
  | { kind: "article"; article: PublicContentArticle }
  | { kind: "redirect"; slug: string }
  | null
> {
  const { rows } = await db.query<PublicDetailRow>(
    `
      select
        a.id,
        v.id as version_id,
        v.content_kind,
        v.slug,
        v.title,
        v.excerpt,
        v.list_cover,
        v.author,
        v.category,
        v.tags,
        v.locale,
        v.featured,
        v.reading_time_minutes,
        a.first_published_at,
        a.published_at,
        greatest(v.created_at, a.published_at) as version_created_at,
        r.kind as route_kind,
        a.published_slug as current_slug,
        v.schema_version,
        case when r.kind = 'current' then v.editorial_graph end as editorial_graph,
        case when r.kind = 'current' then v.document end as document,
        case when r.kind = 'current' then v.hero_image end as hero_image,
        case when r.kind = 'current' then v.social_image end as social_image,
        case when r.kind = 'current' then v.seo end as seo,
        case when r.kind = 'current' then v.word_count end as word_count,
        case when r.kind = 'current' then v.toc end as toc
      from content_routes r
      join content_articles a on a.id = r.article_id
      join content_article_versions v on v.id = a.published_version_id
      where r.slug = $1
        and r.kind in ('current', 'redirect')
        and a.archived_at is null
      limit 1
    `,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.route_kind === "redirect") {
    return { kind: "redirect", slug: row.current_slug };
  }
  const summary = publicSummary(row);
  const document = contentDocumentSchema.parse(row.document);
  const heroImage = row.hero_image
    ? contentImagePlacementSchema.parse(row.hero_image)
    : null;
  const socialImage = row.social_image
    ? contentImagePlacementSchema.parse(row.social_image)
    : null;
  const relatedArticles = await loadRelatedPublicArticles(
    db,
    document,
    summary.id,
  );
  const assets = await resolveContentAssets(
    db,
    [
      ...collectContentAssetReferences({
        document,
        listCover: summary.listCover,
        heroImage,
        socialImage,
        author: summary.author,
      }).map((reference) => reference.assetId),
      ...relatedArticles.flatMap((related) =>
        related.listCover ? [related.listCover.assetId] : [],
      ),
    ],
    true,
  );
  return {
    kind: "article",
    article: {
      ...summary,
      versionId: row.version_id,
      schemaVersion: row.schema_version,
      editorialGraph: contentEditorialGraphSchema.parse(row.editorial_graph),
      document,
      heroImage,
      socialImage,
      seo: contentSeoSchema.parse(row.seo),
      wordCount: row.word_count,
      toc: parseToc(row.toc),
      assets,
      relatedArticles,
    },
  };
}

export async function listPublicContentArticleIndex(
  db: DbQuery,
  inputs: { limit: number; cursor?: string },
): Promise<{
  items: Array<{
    id: string;
    slug: string;
    title: string;
    contentKind: ContentArticleKind;
    locale: string;
    publishedAt: string;
    updatedAt: string;
    listCover: ContentImagePlacement | null;
    listCoverUrl: string | null;
  }>;
  nextCursor: string | null;
}> {
  const cursor = inputs.cursor
    ? decodeContentCursor(inputs.cursor, "public")
    : null;
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string;
    content_kind: ContentArticleKind;
    locale: string;
    list_cover: unknown;
    list_cover_url: string | null;
    published_at: Date | string;
    version_created_at: Date | string;
  }>(
    `
      with page as materialized (
        select a.id, a.published_version_id, a.published_at
        from content_articles a
        where a.published_version_id is not null
          and a.archived_at is null
          and (
            $1::timestamptz is null
            or (a.published_at, a.id) < ($1::timestamptz, $2::uuid)
          )
        order by a.published_at desc, a.id desc
        limit $3
      )
      select
        page.id,
        v.slug,
        v.title,
        v.content_kind,
        v.locale,
        v.list_cover,
        asset.public_url as list_cover_url,
        page.published_at,
        greatest(v.created_at, page.published_at) as version_created_at
      from page
      join content_article_versions v on v.id = page.published_version_id
      left join content_assets asset
        on asset.id = (v.list_cover->>'assetId')::uuid
       and asset.status = 'ready'
      order by page.published_at desc, page.id desc
    `,
    [cursor?.at ?? null, cursor?.id ?? null, inputs.limit + 1],
  );
  const hasMore = rows.length > inputs.limit;
  const selected = rows.slice(0, inputs.limit);
  const items = selected.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    contentKind: row.content_kind,
    locale: row.locale,
    publishedAt: requiredIso(row.published_at),
    updatedAt: requiredIso(row.version_created_at),
    listCover: row.list_cover
      ? contentImagePlacementSchema.parse(row.list_cover)
      : null,
    listCoverUrl: row.list_cover_url,
  }));
  const last = selected.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            kind: "public",
            at: requiredIso(last.published_at),
            id: last.id,
          })
        : null,
  };
}
