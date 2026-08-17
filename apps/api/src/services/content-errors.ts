export type ContentErrorCode =
  | "content_article_not_found"
  | "content_version_not_found"
  | "content_revision_conflict"
  | "content_slug_conflict"
  | "content_article_not_publishable"
  | "content_asset_not_found"
  | "content_asset_not_ready"
  | "content_asset_kind_mismatch"
  | "content_asset_in_use"
  | "content_asset_busy"
  | "content_asset_complete_mismatch"
  | "content_article_archived"
  | "content_document_too_complex"
  | "content_storage_unavailable"
  | "content_publishing_disabled"
  | "content_preview_unavailable"
  | "content_preview_invalid"
  | "content_preview_expired"
  | "content_cursor_invalid";

export class ContentError extends Error {
  constructor(
    public readonly code: ContentErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly issues?: string[],
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ContentError";
  }
}
