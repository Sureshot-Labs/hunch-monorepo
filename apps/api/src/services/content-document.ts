import { createHash } from "node:crypto";

import type {
  ContentAuthor,
  ContentBlock,
  ContentDocument,
  ContentImagePlacement,
  ContentRichText,
} from "../schemas/content-blocks.js";

export type ContentTocItem = {
  id: string;
  level: 2 | 3 | 4;
  text: string;
  anchor: string;
};

export type ContentDocumentDerived = {
  plainText: string;
  wordCount: number;
  readingTimeMinutes: number;
  toc: ContentTocItem[];
};

export type ContentAssetReference = {
  assetId: string;
  role: string;
  blockId: string | null;
};

// An article with one thousand independently managed media references is already
// far beyond a normal newsroom document. Keeping this bound explicit prevents a
// valid 1 MB document from turning one autosave or publish into unbounded DB and
// object-storage work.
export const CONTENT_MAX_ASSET_REFERENCES = 1_000;

export function contentRichTextToText(content: ContentRichText): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "footnoteRef") return `[${node.label}]`;
      return node.text;
    })
    .join("")
    .trim();
}

const TECHNICAL_TEXT_KEYS = new Set([
  "id",
  "type",
  "version",
  "assetId",
  "avatarAssetId",
  "posterAssetId",
  "imageAssetId",
  "href",
  "url",
  "sourceUrl",
  "creditUrl",
  "canonicalUrl",
  "resourceId",
  "provider",
  "style",
  "tone",
  "align",
  "alignment",
  "presentation",
  "crop",
  "aspectRatio",
  "consentCategory",
  "marketId",
  "marketIds",
  "eventId",
  "mode",
  "capturedAt",
  "at",
  "probability",
  "focalX",
  "focalY",
  "depth",
  "checked",
  "newWindow",
  "rel",
  "marks",
]);

function collectDisplayText(value: unknown, key: string | null, out: string[]) {
  if (typeof value === "string") {
    if (!key || !TECHNICAL_TEXT_KEYS.has(key)) {
      const normalized = value.replace(/\s+/g, " ").trim();
      if (normalized) out.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDisplayText(item, key, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectDisplayText(childValue, childKey, out);
  }
}

function anchorBase(text: string): string {
  const normalized = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 100);
  return normalized || "section";
}

export function deriveContentDocument(
  document: ContentDocument,
): ContentDocumentDerived {
  const textParts: string[] = [];
  const toc: ContentTocItem[] = [];
  const anchors = new Map<string, number>();

  for (const block of document.blocks) {
    collectDisplayText(block.data, null, textParts);
    if (block.type !== "heading") continue;
    const text = contentRichTextToText(block.data.content);
    if (!text) continue;
    const requested = block.data.anchor?.trim() || anchorBase(text);
    const occurrence = anchors.get(requested) ?? 0;
    anchors.set(requested, occurrence + 1);
    toc.push({
      id: block.id,
      level: block.data.level,
      text,
      anchor: occurrence === 0 ? requested : `${requested}-${occurrence + 1}`,
    });
  }

  const plainText = textParts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const words = plainText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const wordCount = words.length;
  return {
    plainText,
    wordCount,
    readingTimeMinutes:
      wordCount === 0 ? 0 : Math.max(1, Math.ceil(wordCount / 225)),
    toc,
  };
}

export function contentPayloadHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function addImageReference(
  references: ContentAssetReference[],
  placement: Pick<ContentImagePlacement, "assetId"> | null | undefined,
  role: string,
  blockId: string | null,
) {
  if (!placement) return;
  references.push({ assetId: placement.assetId, role, blockId });
}

function collectBlockAssetReferences(
  block: ContentBlock,
  references: ContentAssetReference[],
) {
  switch (block.type) {
    case "image":
      addImageReference(references, block.data, "body_image", block.id);
      return;
    case "gallery":
      for (const item of block.data.items) {
        addImageReference(references, item, "body_gallery", block.id);
      }
      return;
    case "imageComparison":
      addImageReference(
        references,
        block.data.before,
        "body_comparison",
        block.id,
      );
      addImageReference(
        references,
        block.data.after,
        "body_comparison",
        block.id,
      );
      return;
    case "video":
      references.push({
        assetId: block.data.assetId,
        role: "body_video",
        blockId: block.id,
      });
      if (block.data.posterAssetId) {
        references.push({
          assetId: block.data.posterAssetId,
          role: "body_video_poster",
          blockId: block.id,
        });
      }
      if (block.data.captionsAssetId) {
        references.push({
          assetId: block.data.captionsAssetId,
          role: "body_video_captions",
          blockId: block.id,
        });
      }
      return;
    case "audio":
      references.push({
        assetId: block.data.assetId,
        role: "body_audio",
        blockId: block.id,
      });
      return;
    case "file":
      references.push({
        assetId: block.data.assetId,
        role: "body_file",
        blockId: block.id,
      });
      return;
    case "linkCard":
      if (block.data.imageAssetId) {
        references.push({
          assetId: block.data.imageAssetId,
          role: "body_link_card",
          blockId: block.id,
        });
      }
      return;
    case "columns":
      for (const column of block.data.columns) {
        for (const child of column.blocks) {
          collectBlockAssetReferences(child, references);
        }
      }
      return;
    default:
      return;
  }
}

export function collectContentAssetReferences(inputs: {
  document: ContentDocument;
  listCover: ContentImagePlacement | null;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
  author: ContentAuthor;
}): ContentAssetReference[] {
  const references: ContentAssetReference[] = [];
  addImageReference(references, inputs.listCover, "list_cover", null);
  addImageReference(references, inputs.heroImage, "hero_image", null);
  addImageReference(references, inputs.socialImage, "social_image", null);
  if (inputs.author.avatarAssetId) {
    references.push({
      assetId: inputs.author.avatarAssetId,
      role: "author_avatar",
      blockId: null,
    });
  }
  for (const block of inputs.document.blocks) {
    collectBlockAssetReferences(block, references);
  }
  const deduped = new Map<string, ContentAssetReference>();
  for (const reference of references) {
    deduped.set(
      `${reference.assetId}:${reference.role}:${reference.blockId ?? "root"}`,
      reference,
    );
  }
  return [...deduped.values()];
}

function validateImageAlt(
  issues: string[],
  placement: Pick<ContentImagePlacement, "alt" | "decorative">,
  label: string,
) {
  if (!placement.decorative && !placement.alt.trim()) {
    issues.push(`${label} requires alt text or decorative=true`);
  }
}

function validateBlockForPublication(block: ContentBlock, issues: string[]) {
  switch (block.type) {
    case "image":
      validateImageAlt(issues, block.data, `image block ${block.id}`);
      return;
    case "gallery":
      for (const item of block.data.items) {
        validateImageAlt(issues, item, `gallery item ${item.id}`);
      }
      return;
    case "imageComparison":
      validateImageAlt(
        issues,
        block.data.before,
        `comparison before ${block.id}`,
      );
      validateImageAlt(
        issues,
        block.data.after,
        `comparison after ${block.id}`,
      );
      return;
    case "table":
      for (const row of block.data.rows) {
        if (row.cells.length !== block.data.columns.length) {
          issues.push(
            `table row ${row.id} must have ${block.data.columns.length} cells`,
          );
        }
      }
      return;
    case "video":
      if (
        block.data.hasAudio &&
        !block.data.captionsAssetId &&
        contentRichTextToText(block.data.transcript ?? []).length === 0
      ) {
        issues.push(
          `video block ${block.id} requires captions or a transcript when it has audio`,
        );
      }
      return;
    case "audio":
      if (contentRichTextToText(block.data.transcript ?? []).length === 0) {
        issues.push(`audio block ${block.id} requires a transcript`);
      }
      return;
    case "columns":
      for (const column of block.data.columns) {
        for (const child of column.blocks)
          validateBlockForPublication(child, issues);
      }
      return;
    default:
      return;
  }
}

export function validateContentDocumentForPublication(inputs: {
  document: ContentDocument;
  listCover: ContentImagePlacement | null;
  heroImage: ContentImagePlacement | null;
  socialImage: ContentImagePlacement | null;
}): string[] {
  const issues: string[] = [];
  if (inputs.document.blocks.length === 0) {
    issues.push("document must contain at least one block");
  }
  if (inputs.listCover)
    validateImageAlt(issues, inputs.listCover, "list cover");
  if (inputs.heroImage)
    validateImageAlt(issues, inputs.heroImage, "hero image");
  if (inputs.socialImage)
    validateImageAlt(issues, inputs.socialImage, "social image");
  if (inputs.listCover?.decorative) {
    issues.push("list cover cannot be decorative");
  }
  if (inputs.socialImage?.decorative) {
    issues.push("social image cannot be decorative");
  }

  let previousHeadingLevel: number | null = null;
  for (const block of inputs.document.blocks) {
    validateBlockForPublication(block, issues);
    if (block.type !== "heading") continue;
    const headingText = contentRichTextToText(block.data.content);
    if (!headingText) issues.push(`heading block ${block.id} cannot be empty`);
    if (previousHeadingLevel === null && block.data.level !== 2) {
      issues.push("the first body heading must be level 2");
    } else if (
      previousHeadingLevel !== null &&
      block.data.level > previousHeadingLevel + 1
    ) {
      issues.push(
        `heading block ${block.id} jumps from H${previousHeadingLevel} to H${block.data.level}`,
      );
    }
    previousHeadingLevel = block.data.level;
  }
  return issues;
}
