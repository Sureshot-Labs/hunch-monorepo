import { randomUUID } from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { tx, type Pool } from "@hunch/infra";
import { imageSize } from "image-size";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  contentAssetCompleteBodySchema,
  contentAssetCreateBodySchema,
  contentAssetUpdateBodySchema,
  type ContentAssetCompleteBody,
  type ContentAssetCreateBody,
  type ContentAssetUpdateBody,
} from "../schemas/content.js";
import { ContentError } from "./content.js";

type AssetRow = {
  id: string;
  status: ContentAsset["status"];
  kind: ContentAsset["kind"];
  storage_key: string;
  public_url: string | null;
  original_filename: string;
  mime_type: string;
  byte_size: string | number | bigint | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  default_alt: string | null;
  default_caption: string | null;
  credit_name: string | null;
  credit_url: string | null;
  focal_x: string | number | null;
  focal_y: string | number | null;
  metadata: Record<string, unknown>;
  created_by_admin_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  ready_at: Date | string | null;
  deleted_at: Date | string | null;
};

export type ContentAsset = {
  id: string;
  status: "pending" | "verifying" | "ready" | "failed" | "deleted";
  kind: "image" | "video" | "audio" | "file";
  storageKey: string;
  publicUrl: string | null;
  originalFilename: string;
  mimeType: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  checksumSha256: string | null;
  defaultAlt: string | null;
  defaultCaption: string | null;
  creditName: string | null;
  creditUrl: string | null;
  focalX: number | null;
  focalY: number | null;
  metadata: Record<string, unknown>;
  createdByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  deletedAt: string | null;
};

export type ContentAssetUploadIntent = {
  asset: ContentAsset;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
};

const ASSET_COLUMNS = `
  id, status, kind, storage_key, public_url, original_filename, mime_type,
  byte_size, width, height, duration_ms, checksum_sha256, default_alt,
  default_caption, credit_name, credit_url, focal_x, focal_y, metadata,
  created_by_admin_id, created_at, updated_at, ready_at, deleted_at
`;

const ALLOWED_MIME_BY_KIND: Record<ContentAsset["kind"], Set<string>> = {
  image: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
  ]),
  video: new Set(["video/mp4", "video/webm"]),
  audio: new Set([
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
  ]),
  file: new Set([
    "application/pdf",
    "application/zip",
    "text/plain",
    "text/csv",
    "application/json",
    "text/vtt",
  ]),
};

const MAX_BYTES_BY_KIND: Record<ContentAsset["kind"], number> = {
  image: 20_000_000,
  video: 500_000_000,
  audio: 100_000_000,
  file: 100_000_000,
};

const IMAGE_MIME_BY_DETECTED_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "text/vtt": ".vtt",
};

const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 100_000_000;

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

function assetFromRow(row: AssetRow): ContentAsset {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    storageKey: row.storage_key,
    publicUrl: row.public_url,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    checksumSha256: row.checksum_sha256,
    defaultAlt: row.default_alt,
    defaultCaption: row.default_caption,
    creditName: row.credit_name,
    creditUrl: row.credit_url,
    focalX: row.focal_x == null ? null : Number(row.focal_x),
    focalY: row.focal_y == null ? null : Number(row.focal_y),
    metadata: row.metadata,
    createdByAdminId: row.created_by_admin_id,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    readyAt: iso(row.ready_at),
    deletedAt: iso(row.deleted_at),
  };
}

function storageConfigured(): boolean {
  return env.contentAssetStorageConfigured;
}

let storageClient: S3Client | null = null;

function requireStorage(): S3Client {
  if (!storageConfigured()) {
    throw new ContentError(
      "content_storage_unavailable",
      "Content object storage is not configured",
      503,
    );
  }
  const staticCredentials = env.contentAssetStaticCredentialsConfigured
    ? {
        credentials: {
          accessKeyId: env.contentAssetS3AccessKeyId,
          secretAccessKey: env.contentAssetS3SecretAccessKey,
        },
      }
    : {};
  storageClient ??= new S3Client({
    ...(env.contentAssetS3Endpoint
      ? { endpoint: env.contentAssetS3Endpoint }
      : {}),
    region: env.contentAssetS3Region,
    forcePathStyle: env.contentAssetS3ForcePathStyle,
    ...staticCredentials,
  });
  return storageClient;
}

function extensionForMime(mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType.toLowerCase()];
  if (!extension) throw new Error(`Missing extension mapping for ${mimeType}`);
  return extension;
}

function stagingStorageKey(assetId: string, mimeType: string): string {
  return `content-staging/${assetId}${extensionForMime(mimeType)}`;
}

function publicStorageKey(
  assetId: string,
  mimeType: string,
  checksumSha256: string,
): string {
  return `content/${checksumSha256.slice(0, 2)}/${assetId}-${checksumSha256.slice(0, 16)}${extensionForMime(mimeType)}`;
}

function publicUrl(key: string): string {
  return `${env.contentAssetPublicBaseUrl}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function assertUploadPolicy(body: ContentAssetCreateBody) {
  if (!ALLOWED_MIME_BY_KIND[body.kind].has(body.mimeType.toLowerCase())) {
    throw new ContentError(
      "content_asset_kind_mismatch",
      `MIME type ${body.mimeType} is not allowed for ${body.kind}`,
      422,
    );
  }
  if (body.expectedByteSize > MAX_BYTES_BY_KIND[body.kind]) {
    throw new ContentError(
      "content_asset_kind_mismatch",
      `${body.kind} exceeds the ${MAX_BYTES_BY_KIND[body.kind]} byte limit`,
      413,
    );
  }
}

export async function createContentAssetUpload(
  pool: Pool,
  rawBody: ContentAssetCreateBody,
  actorAdminId: string | null,
): Promise<ContentAssetUploadIntent> {
  const body = contentAssetCreateBodySchema.parse(rawBody);
  assertUploadPolicy(body);
  const client = requireStorage();
  const assetId = randomUUID();
  const key = stagingStorageKey(assetId, body.mimeType);
  const encodedChecksum = Buffer.from(body.checksumSha256, "hex").toString(
    "base64",
  );
  const command = new PutObjectCommand({
    Bucket: env.contentAssetS3Bucket,
    Key: key,
    ContentType: body.mimeType,
    ChecksumSHA256: encodedChecksum,
  });
  const expiresAt = new Date(Date.now() + env.contentAssetUploadTtlSec * 1_000);
  const url = await getSignedUrl(client, command, {
    expiresIn: env.contentAssetUploadTtlSec,
  });
  const { rows } = await pool.query<AssetRow>(
    `
      insert into content_assets (
        id, status, kind, storage_key, public_url, original_filename, mime_type,
        byte_size, checksum_sha256, default_alt, default_caption, credit_name,
        credit_url, metadata, created_by_admin_id
      ) values (
        $1, 'pending', $2, $3, null, $4, $5, $6, $7, $8, $9, $10, $11,
        $12::jsonb, $13
      )
      returning ${ASSET_COLUMNS}
    `,
    [
      assetId,
      body.kind,
      key,
      body.originalFilename,
      body.mimeType.toLowerCase(),
      body.expectedByteSize,
      body.checksumSha256,
      body.defaultAlt ?? null,
      body.defaultCaption ?? null,
      body.creditName ?? null,
      body.creditUrl ?? null,
      JSON.stringify(body.metadata ?? {}),
      actorAdminId,
    ],
  );
  return {
    asset: assetFromRow(rows[0]),
    upload: {
      method: "PUT",
      url,
      headers: {
        "content-type": body.mimeType.toLowerCase(),
        "x-amz-checksum-sha256": encodedChecksum,
      },
      expiresAt: expiresAt.toISOString(),
    },
  };
}

async function enqueueStorageDeletion(
  db: DbQuery,
  key: string,
  availableAt: Date = new Date(),
): Promise<void> {
  await db.query(
    `
      insert into content_storage_deletion_jobs (storage_key, available_at)
      values ($1, $2)
      on conflict (storage_key) do update
      set
        status = case
          when content_storage_deletion_jobs.status = 'completed' then 'completed'
          else 'pending'
        end,
        available_at = least(content_storage_deletion_jobs.available_at, excluded.available_at),
        locked_at = null,
        locked_by = null
    `,
    [key, availableAt],
  );
}

function stagingDeletionAvailableAt(): Date {
  // A presigned PUT is reusable until it expires. Deleting only immediately
  // would let a holder recreate an orphaned staging object afterwards.
  return new Date(Date.now() + (env.contentAssetUploadTtlSec + 60) * 1_000);
}

function encodedChecksum(checksumSha256: string): string {
  return Buffer.from(checksumSha256, "hex").toString("base64");
}

function copySource(key: string): string {
  return [env.contentAssetS3Bucket, ...key.split("/")]
    .map(encodeURIComponent)
    .join("/");
}

async function readObjectPrefix(
  client: S3Client,
  key: string,
): Promise<Buffer> {
  const object = await client.send(
    new GetObjectCommand({
      Bucket: env.contentAssetS3Bucket,
      Key: key,
      Range: "bytes=0-1048575",
    }),
  );
  if (!object.Body) throw new Error("Object body is empty");
  return Buffer.from(await object.Body.transformToByteArray());
}

function hasAsciiAt(bytes: Buffer, offset: number, value: string): boolean {
  return (
    bytes.subarray(offset, offset + value.length).toString("ascii") === value
  );
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bytesMatchMime(mimeType: string, bytes: Buffer): boolean {
  switch (mimeType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return hasAsciiAt(bytes, 0, "GIF87a") || hasAsciiAt(bytes, 0, "GIF89a");
    case "image/webp":
      return hasAsciiAt(bytes, 0, "RIFF") && hasAsciiAt(bytes, 8, "WEBP");
    case "image/avif":
      return (
        hasAsciiAt(bytes, 4, "ftyp") &&
        /avi[fs]/.test(bytes.subarray(8, 32).toString("ascii"))
      );
    case "video/mp4":
    case "audio/mp4":
      return hasAsciiAt(bytes, 4, "ftyp");
    case "video/webm":
    case "audio/webm":
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case "audio/mpeg":
      return (
        hasAsciiAt(bytes, 0, "ID3") ||
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
    case "audio/ogg":
      return hasAsciiAt(bytes, 0, "OggS");
    case "audio/wav":
      return hasAsciiAt(bytes, 0, "RIFF") && hasAsciiAt(bytes, 8, "WAVE");
    case "application/pdf":
      return hasAsciiAt(bytes, 0, "%PDF-");
    case "application/zip":
      return (
        bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
        bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
      );
    case "text/vtt":
      return (
        isUtf8Text(bytes) &&
        bytes.toString("utf8").trimStart().startsWith("WEBVTT")
      );
    case "application/json": {
      if (!isUtf8Text(bytes)) return false;
      const first = bytes.toString("utf8").trimStart()[0];
      return first === "{" || first === "[";
    }
    case "text/plain":
    case "text/csv":
      return isUtf8Text(bytes);
    default:
      return false;
  }
}

async function failAssetVerification(
  pool: Pool,
  assetId: string,
  stagingKey: string,
  targetKey: string,
  issues: string[],
): Promise<void> {
  await tx(pool, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `
        update content_assets
        set status = 'failed', metadata = metadata || $2::jsonb
        where id = $1 and status = 'verifying'
        returning id
      `,
      [assetId, JSON.stringify({ completionIssues: issues })],
    );
    if (rows[0]) {
      await enqueueStorageDeletion(
        db,
        stagingKey,
        stagingDeletionAvailableAt(),
      );
      await enqueueStorageDeletion(db, targetKey);
      return;
    }
    const { rows: currentRows } = await db.query<{ status: string }>(
      "select status from content_assets where id = $1",
      [assetId],
    );
    // A COMMIT acknowledgement can be lost after the database has already
    // made the asset ready. Never delete the promoted public object in that
    // ambiguous state; deleting the staging source remains safe/idempotent.
    if (currentRows[0]?.status === "ready") {
      await enqueueStorageDeletion(
        db,
        stagingKey,
        stagingDeletionAvailableAt(),
      );
    }
  });
}

export async function completeContentAssetUpload(
  pool: Pool,
  assetId: string,
  rawBody: ContentAssetCompleteBody,
  actorAdminId: string | null = null,
): Promise<ContentAsset> {
  const body = contentAssetCompleteBodySchema.parse(rawBody);
  const client = requireStorage();
  const claim = await tx(pool, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `select ${ASSET_COLUMNS} from content_assets where id = $1 for update`,
      [assetId],
    );
    const existing = rows[0];
    if (!existing || existing.status === "deleted") {
      throw new ContentError(
        "content_asset_not_found",
        "Content asset not found",
        404,
      );
    }
    if (existing.status === "ready") return { existing, ready: true as const };
    if (existing.status !== "pending") {
      throw new ContentError(
        "content_asset_busy",
        "Content asset is already being verified or has failed",
        409,
      );
    }
    if (!existing.checksum_sha256) {
      throw new ContentError(
        "content_asset_not_ready",
        "A checksum is required before an asset can be verified",
        422,
      );
    }
    const targetKey = publicStorageKey(
      existing.id,
      existing.mime_type,
      existing.checksum_sha256,
    );
    const { rows: claimedRows } = await db.query<AssetRow>(
      `
        update content_assets
        set
          status = 'verifying',
          metadata = metadata || $2::jsonb
        where id = $1 and status = 'pending'
        returning ${ASSET_COLUMNS}
      `,
      [assetId, JSON.stringify({ verificationTargetKey: targetKey })],
    );
    if (!claimedRows[0]) {
      throw new ContentError(
        "content_asset_busy",
        "Content asset verification was claimed concurrently",
        409,
      );
    }
    return { existing: claimedRows[0], ready: false as const, targetKey };
  });
  if (claim.ready) return assetFromRow(claim.existing);

  const existing = claim.existing;
  const targetKey = claim.targetKey;
  const checksumSha256 = existing.checksum_sha256;
  if (!checksumSha256) {
    throw new Error("Claimed content asset is missing its required checksum");
  }
  const issues: string[] = [];
  let verifiedWidth: number | null = null;
  let verifiedHeight: number | null = null;
  try {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: env.contentAssetS3Bucket,
        Key: existing.storage_key,
        ChecksumMode: "ENABLED",
      }),
    );
    const storedSize = Number(head.ContentLength ?? -1);
    const storedType = head.ContentType?.toLowerCase() ?? "";
    if (
      storedSize !== body.byteSize ||
      storedSize !== Number(existing.byte_size)
    ) {
      issues.push("uploaded byte size does not match the upload intent");
    }
    if (storedType !== existing.mime_type.toLowerCase()) {
      issues.push("uploaded MIME type does not match the upload intent");
    }
    if (body.checksumSha256 !== existing.checksum_sha256) {
      issues.push("reported checksum does not match the upload intent");
    }
    const expectedChecksum = encodedChecksum(checksumSha256);
    if (!head.ChecksumSHA256) {
      issues.push(
        "object storage did not return a verifiable SHA-256 checksum",
      );
    } else if (head.ChecksumSHA256 !== expectedChecksum) {
      issues.push("uploaded checksum does not match the upload intent");
    }

    const prefix = await readObjectPrefix(client, existing.storage_key);
    if (!bytesMatchMime(existing.mime_type.toLowerCase(), prefix)) {
      issues.push("uploaded bytes do not match the declared MIME type");
    }
    if (existing.kind === "image") {
      const dimensions = imageSize(prefix);
      if (!dimensions.width || !dimensions.height) {
        throw new Error("Image dimensions are unavailable");
      }
      const detectedMime = dimensions.type
        ? IMAGE_MIME_BY_DETECTED_TYPE[dimensions.type]
        : null;
      if (!detectedMime || detectedMime !== existing.mime_type.toLowerCase()) {
        issues.push("uploaded image bytes do not match the declared MIME type");
      }
      verifiedWidth = dimensions.width;
      verifiedHeight = dimensions.height;
      if (
        verifiedWidth > MAX_IMAGE_DIMENSION ||
        verifiedHeight > MAX_IMAGE_DIMENSION ||
        verifiedWidth * verifiedHeight > MAX_IMAGE_PIXELS
      ) {
        issues.push("uploaded image exceeds the safe dimension or pixel limit");
      }
      if (body.width && body.width !== verifiedWidth) {
        issues.push("reported image width does not match the uploaded object");
      }
      if (body.height && body.height !== verifiedHeight) {
        issues.push("reported image height does not match the uploaded object");
      }
    }
  } catch (error) {
    issues.push(
      `uploaded object could not be inspected: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
  if (issues.length > 0) {
    await failAssetVerification(
      pool,
      assetId,
      existing.storage_key,
      targetKey,
      issues,
    );
    throw new ContentError(
      "content_asset_not_ready",
      "Uploaded object failed verification",
      422,
      issues,
    );
  }
  try {
    await client.send(
      new CopyObjectCommand({
        Bucket: env.contentAssetS3Bucket,
        Key: targetKey,
        CopySource: copySource(existing.storage_key),
        ChecksumAlgorithm: "SHA256",
        MetadataDirective: "REPLACE",
        ContentType: existing.mime_type,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    const promotedHead = await client.send(
      new HeadObjectCommand({
        Bucket: env.contentAssetS3Bucket,
        Key: targetKey,
        ChecksumMode: "ENABLED",
      }),
    );
    if (
      Number(promotedHead.ContentLength ?? -1) !== body.byteSize ||
      promotedHead.ChecksumSHA256 !== encodedChecksum(checksumSha256)
    ) {
      throw new Error("Promoted object failed immutable copy verification");
    }
    return await tx(pool, async (db) => {
      const { rows: updatedRows } = await db.query<AssetRow>(
        `
          update content_assets
          set
            status = 'ready',
            storage_key = $2,
            public_url = $3,
            byte_size = $4,
            checksum_sha256 = $5,
            width = $6,
            height = $7,
            duration_ms = null,
            ready_at = now(),
            deleted_at = null,
            metadata = metadata - 'verificationTargetKey' - 'completionIssues'
          where id = $1 and status = 'verifying'
          returning ${ASSET_COLUMNS}
        `,
        [
          assetId,
          targetKey,
          publicUrl(targetKey),
          body.byteSize,
          checksumSha256,
          verifiedWidth,
          verifiedHeight,
        ],
      );
      if (!updatedRows[0]) {
        throw new ContentError(
          "content_asset_busy",
          "Content asset changed while verification was in progress",
          409,
        );
      }
      await enqueueStorageDeletion(
        db,
        existing.storage_key,
        stagingDeletionAvailableAt(),
      );
      await db.query(
        `
          insert into content_audit_events (action, asset_id, actor_admin_id)
          values ('asset.ready', $1, $2)
        `,
        [assetId, actorAdminId],
      );
      return assetFromRow(updatedRows[0]);
    });
  } catch (error) {
    const promotionIssues = [
      `asset promotion failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    ];
    await failAssetVerification(
      pool,
      assetId,
      existing.storage_key,
      targetKey,
      promotionIssues,
    );
    if (error instanceof ContentError) throw error;
    throw new ContentError(
      "content_asset_not_ready",
      "Uploaded object could not be promoted safely",
      502,
      promotionIssues,
    );
  }
}

export async function getContentAsset(
  db: DbQuery,
  assetId: string,
): Promise<ContentAsset | null> {
  const { rows } = await db.query<AssetRow>(
    `select ${ASSET_COLUMNS} from content_assets where id = $1 limit 1`,
    [assetId],
  );
  return rows[0] ? assetFromRow(rows[0]) : null;
}

export async function updateContentAsset(
  pool: Pool,
  assetId: string,
  rawBody: ContentAssetUpdateBody,
  actorAdminId: string | null,
): Promise<ContentAsset> {
  const body = contentAssetUpdateBodySchema.parse(rawBody);
  return tx(pool, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `
        update content_assets
        set
          default_alt = case when $2 then $3 else default_alt end,
          default_caption = case when $4 then $5 else default_caption end,
          credit_name = case when $6 then $7 else credit_name end,
          credit_url = case when $8 then $9 else credit_url end,
          focal_x = case when $10 then $11 else focal_x end,
          focal_y = case when $12 then $13 else focal_y end
        where id = $1 and status <> 'deleted'
        returning ${ASSET_COLUMNS}
      `,
      [
        assetId,
        body.defaultAlt !== undefined,
        body.defaultAlt ?? null,
        body.defaultCaption !== undefined,
        body.defaultCaption ?? null,
        body.creditName !== undefined,
        body.creditName ?? null,
        body.creditUrl !== undefined,
        body.creditUrl ?? null,
        body.focalX !== undefined,
        body.focalX ?? null,
        body.focalY !== undefined,
        body.focalY ?? null,
      ],
    );
    if (!rows[0]) {
      throw new ContentError(
        "content_asset_not_found",
        "Content asset not found",
        404,
      );
    }
    await db.query(
      `
        insert into content_audit_events (action, asset_id, actor_admin_id)
        values ('asset.metadata_updated', $1, $2)
      `,
      [assetId, actorAdminId],
    );
    return assetFromRow(rows[0]);
  });
}

function encodeAssetCursor(at: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ kind: "asset", at, id }),
    "utf8",
  ).toString("base64url");
}

function decodeAssetCursor(raw: string): { at: string; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.kind !== "asset" ||
      typeof value.at !== "string" ||
      !Number.isFinite(new Date(value.at).getTime()) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.id,
      )
    ) {
      throw new Error("invalid asset cursor");
    }
    return { at: value.at, id: value.id };
  } catch {
    throw new ContentError(
      "content_cursor_invalid",
      "Invalid asset cursor",
      400,
    );
  }
}

export async function listContentAssets(
  db: DbQuery,
  inputs: {
    limit: number;
    cursor?: string;
    kind?: ContentAsset["kind"];
    status?: ContentAsset["status"];
  },
): Promise<{ items: ContentAsset[]; nextCursor: string | null }> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (inputs.kind) {
    values.push(inputs.kind);
    where.push(`kind = $${values.length}`);
  }
  if (inputs.status) {
    values.push(inputs.status);
    where.push(`status = $${values.length}`);
  }
  const cursor = inputs.cursor ? decodeAssetCursor(inputs.cursor) : null;
  if (cursor) {
    values.push(cursor.at, cursor.id);
    where.push(
      `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(inputs.limit + 1);
  const { rows } = await db.query<AssetRow>(
    `
      select ${ASSET_COLUMNS}
      from content_assets
      ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
      order by created_at desc, id desc
      limit $${values.length}
    `,
    values,
  );
  const hasMore = rows.length > inputs.limit;
  const items = rows.slice(0, inputs.limit).map(assetFromRow);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last ? encodeAssetCursor(last.createdAt, last.id) : null,
  };
}

export async function deleteContentAsset(
  pool: Pool,
  assetId: string,
  actorAdminId: string | null = null,
): Promise<ContentAsset> {
  return tx(pool, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `select ${ASSET_COLUMNS} from content_assets where id = $1 for update`,
      [assetId],
    );
    const existing = rows[0];
    if (!existing) {
      throw new ContentError(
        "content_asset_not_found",
        "Content asset not found",
        404,
      );
    }
    if (existing.status === "deleted") return assetFromRow(existing);
    if (existing.status === "verifying") {
      throw new ContentError(
        "content_asset_busy",
        "Wait for asset verification to finish before deleting it",
        409,
      );
    }
    const { rows: usageRows } = await db.query<{ count: string }>(
      "select count(*)::text as count from content_asset_usages where asset_id = $1",
      [assetId],
    );
    if (Number(usageRows[0]?.count ?? 0) > 0) {
      throw new ContentError(
        "content_asset_in_use",
        "Content asset is referenced by an article draft or version",
        409,
      );
    }
    const { rows: updatedRows } = await db.query<AssetRow>(
      `
        update content_assets
        set status = 'deleted', deleted_at = now()
        where id = $1
        returning ${ASSET_COLUMNS}
      `,
      [assetId],
    );
    await enqueueStorageDeletion(
      db,
      existing.storage_key,
      existing.storage_key.startsWith("content-staging/")
        ? stagingDeletionAvailableAt()
        : new Date(),
    );
    const verificationTarget = existing.metadata.verificationTargetKey;
    if (typeof verificationTarget === "string" && verificationTarget) {
      await enqueueStorageDeletion(db, verificationTarget);
    }
    await db.query(
      `
        insert into content_audit_events (action, asset_id, actor_admin_id)
        values ('asset.deleted', $1, $2)
      `,
      [assetId, actorAdminId],
    );
    return assetFromRow(updatedRows[0]);
  });
}

export async function deleteStoredContentObject(
  storageKey: string,
): Promise<void> {
  const client = requireStorage();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.contentAssetS3Bucket,
      Key: storageKey,
    }),
  );
}

export function isContentStorageConfigured(): boolean {
  return storageConfigured();
}

export async function reclaimStaleContentAssetUploads(
  pool: Pool,
  limit: number,
): Promise<number> {
  return tx(pool, async (db) => {
    const { rows } = await db.query<AssetRow>(
      `
        select ${ASSET_COLUMNS}
        from content_assets
        where (
          status = 'verifying' and updated_at < now() - interval '10 minutes'
        ) or (
          status = 'pending' and created_at < now() - interval '24 hours'
        )
        order by updated_at, id
        for update skip locked
        limit $1
      `,
      [limit],
    );
    for (const row of rows) {
      await db.query(
        `
          update content_assets
          set
            status = 'failed',
            metadata = metadata || '{"completionIssues":["upload or verification expired"]}'::jsonb
          where id = $1
        `,
        [row.id],
      );
      await enqueueStorageDeletion(db, row.storage_key);
      const target = row.metadata.verificationTargetKey;
      if (typeof target === "string" && target) {
        await enqueueStorageDeletion(db, target);
      }
    }
    return rows.length;
  });
}
