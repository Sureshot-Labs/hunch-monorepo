export const CONTENT_RENDERER_CONTRACT_ID =
  "hunch-content-document-v1" as const;

export type ContentRuntimeConfig = {
  enabled: boolean;
  journalServiceApiEnabled: boolean;
  journalServiceReviewSubmitEnabled: boolean;
  journalServiceTokenPepper: string;
  journalServiceCredentialMaxTtlDays: number;
  journalServiceReadRatePerMinute: number;
  journalServiceMutationRatePerMinute: number;
  journalServiceUploadRatePerMinute: number;
  journalServiceMaxConcurrentVerifications: number;
  journalServiceDailyUploadBytes: number;
  journalServiceIdempotencyLeaseSec: number;
  publishingEnabled: boolean;
  requireApproval: boolean;
  rendererContractId: string;
  workerEnabled: boolean;
  workerPollMs: number;
  workerBatchSize: number;
  workerMaxAttempts: number;
  retentionDays: number;
  auditRetentionDays: number;
  dbPublicPoolMax: number;
  dbAdminPoolMax: number;
  dbWorkerPoolMax: number;
  dbPublicStatementTimeoutMs: number;
  dbAdminStatementTimeoutMs: number;
  dbWorkerStatementTimeoutMs: number;
  dbLockTimeoutMs: number;
  revalidateUrl: string;
  revalidateSecret: string;
  revalidateTimeoutMs: number;
  previewSecret: string;
  assetS3Endpoint: string;
  assetS3Region: string;
  assetS3Bucket: string;
  assetS3AccessKeyId: string;
  assetS3SecretAccessKey: string;
  assetS3ForcePathStyle: boolean;
  assetPublicBaseUrl: string;
  assetUploadTtlSec: number;
  assetStaticCredentialsConfigured: boolean;
  assetStorageConfigured: boolean;
};

function text(source: NodeJS.ProcessEnv, key: string): string {
  return source[key]?.trim() ?? "";
}

function bool(
  source: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const value = text(source, key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`[env] ${key} must be a boolean`);
}

function int(
  source: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = text(source, key);
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`[env] ${key} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`[env] ${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function httpUrl(name: string, value: string, production: boolean): void {
  if (!value) return;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`[env] ${name} must be an HTTP(S) URL`);
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error(`[env] ${name} must use HTTPS in production`);
  }
}

export function resolveContentRuntimeConfig(
  source: NodeJS.ProcessEnv,
  nodeEnv = source.NODE_ENV ?? "development",
): ContentRuntimeConfig {
  const production = nodeEnv.toLowerCase() === "production";
  const enabled = bool(source, "CONTENT_ENABLED", false);
  const journalServiceApiEnabled = bool(
    source,
    "JOURNAL_SERVICE_API_ENABLED",
    false,
  );
  const journalServiceReviewSubmitEnabled = bool(
    source,
    "JOURNAL_SERVICE_REVIEW_SUBMIT_ENABLED",
    false,
  );
  const journalServiceTokenPepper = text(
    source,
    "JOURNAL_SERVICE_TOKEN_PEPPER",
  );
  const publishingEnabled = bool(source, "CONTENT_PUBLISHING_ENABLED", false);
  const workerEnabled = bool(source, "CONTENT_WORKER_ENABLED", false);
  const revalidateUrl = text(source, "CONTENT_REVALIDATE_URL");
  const revalidateSecret = text(source, "CONTENT_REVALIDATE_SECRET");
  const previewSecret = text(source, "CONTENT_PREVIEW_SECRET");
  const endpoint = text(source, "CONTENT_ASSET_S3_ENDPOINT").replace(
    /\/+$/,
    "",
  );
  const explicitRegion = text(source, "CONTENT_ASSET_S3_REGION");
  const awsRegion =
    text(source, "AWS_REGION") || text(source, "AWS_DEFAULT_REGION");
  const assetS3Region =
    !endpoint && explicitRegion.toLowerCase() === "auto"
      ? awsRegion || "us-east-1"
      : explicitRegion || awsRegion || (endpoint ? "auto" : "us-east-1");
  const assetS3Bucket = text(source, "CONTENT_ASSET_S3_BUCKET");
  const assetPublicBaseUrl = text(
    source,
    "CONTENT_ASSET_PUBLIC_BASE_URL",
  ).replace(/\/+$/, "");
  const assetS3AccessKeyId = text(source, "CONTENT_ASSET_S3_ACCESS_KEY_ID");
  const assetS3SecretAccessKey = text(
    source,
    "CONTENT_ASSET_S3_SECRET_ACCESS_KEY",
  );

  if (Boolean(revalidateUrl) !== Boolean(revalidateSecret)) {
    throw new Error(
      "[env] CONTENT_REVALIDATE_URL and CONTENT_REVALIDATE_SECRET must be configured together",
    );
  }
  if (revalidateSecret && revalidateSecret.length < 32) {
    throw new Error(
      "[env] CONTENT_REVALIDATE_SECRET must be at least 32 characters",
    );
  }
  if (previewSecret && previewSecret.length < 32) {
    throw new Error(
      "[env] CONTENT_PREVIEW_SECRET must be at least 32 characters",
    );
  }
  if (journalServiceApiEnabled && !enabled) {
    throw new Error(
      "[env] CONTENT_ENABLED must be true when JOURNAL_SERVICE_API_ENABLED is enabled",
    );
  }
  if (journalServiceApiEnabled && journalServiceTokenPepper.length < 32) {
    throw new Error(
      "[env] JOURNAL_SERVICE_TOKEN_PEPPER must be at least 32 characters when the service API is enabled",
    );
  }
  if (journalServiceReviewSubmitEnabled && !journalServiceApiEnabled) {
    throw new Error(
      "[env] JOURNAL_SERVICE_API_ENABLED must be true when JOURNAL_SERVICE_REVIEW_SUBMIT_ENABLED is enabled",
    );
  }
  if (Boolean(assetS3AccessKeyId) !== Boolean(assetS3SecretAccessKey)) {
    throw new Error(
      "[env] CONTENT_ASSET_S3_ACCESS_KEY_ID and CONTENT_ASSET_S3_SECRET_ACCESS_KEY must be configured together",
    );
  }
  if (production && (assetS3AccessKeyId || assetS3SecretAccessKey)) {
    throw new Error(
      "[env] static content S3 credentials are forbidden in production; use the AWS role credential chain",
    );
  }

  const assetStorageConfigured = Boolean(assetS3Bucket && assetPublicBaseUrl);
  const storageRequested = Boolean(
    endpoint ||
    assetS3Bucket ||
    assetPublicBaseUrl ||
    assetS3AccessKeyId ||
    assetS3SecretAccessKey,
  );
  if (storageRequested && !assetStorageConfigured) {
    throw new Error(
      "[env] CONTENT_ASSET_S3_BUCKET and CONTENT_ASSET_PUBLIC_BASE_URL are required for content storage",
    );
  }

  httpUrl("CONTENT_REVALIDATE_URL", revalidateUrl, production);
  httpUrl("CONTENT_ASSET_S3_ENDPOINT", endpoint, production);
  httpUrl("CONTENT_ASSET_PUBLIC_BASE_URL", assetPublicBaseUrl, production);

  const rendererContractId = text(source, "CONTENT_RENDERER_CONTRACT_ID");
  if (publishingEnabled) {
    if (!enabled || !workerEnabled) {
      throw new Error(
        "[env] CONTENT_ENABLED and CONTENT_WORKER_ENABLED must be true when publishing is enabled",
      );
    }
    if (rendererContractId !== CONTENT_RENDERER_CONTRACT_ID) {
      throw new Error(
        `[env] CONTENT_RENDERER_CONTRACT_ID must equal ${CONTENT_RENDERER_CONTRACT_ID} when publishing is enabled`,
      );
    }
    if (!revalidateUrl || !revalidateSecret) {
      throw new Error(
        "[env] content revalidation must be configured when publishing is enabled",
      );
    }
    if (!assetStorageConfigured) {
      throw new Error(
        "[env] content object storage must be configured when publishing is enabled",
      );
    }
  }

  return {
    enabled,
    journalServiceApiEnabled,
    journalServiceReviewSubmitEnabled,
    journalServiceTokenPepper,
    journalServiceCredentialMaxTtlDays: int(
      source,
      "JOURNAL_SERVICE_CREDENTIAL_MAX_TTL_DAYS",
      90,
      1,
      365,
    ),
    journalServiceReadRatePerMinute: int(
      source,
      "JOURNAL_SERVICE_READ_RATE_PER_MINUTE",
      120,
      1,
      10_000,
    ),
    journalServiceMutationRatePerMinute: int(
      source,
      "JOURNAL_SERVICE_MUTATION_RATE_PER_MINUTE",
      30,
      1,
      1_000,
    ),
    journalServiceUploadRatePerMinute: int(
      source,
      "JOURNAL_SERVICE_UPLOAD_RATE_PER_MINUTE",
      10,
      1,
      1_000,
    ),
    journalServiceMaxConcurrentVerifications: int(
      source,
      "JOURNAL_SERVICE_MAX_CONCURRENT_VERIFICATIONS",
      5,
      1,
      100,
    ),
    journalServiceDailyUploadBytes: int(
      source,
      "JOURNAL_SERVICE_DAILY_UPLOAD_BYTES",
      500_000_000,
      1_000_000,
      10_000_000_000,
    ),
    journalServiceIdempotencyLeaseSec: int(
      source,
      "JOURNAL_SERVICE_IDEMPOTENCY_LEASE_SEC",
      30,
      5,
      300,
    ),
    publishingEnabled,
    requireApproval: bool(source, "CONTENT_REQUIRE_APPROVAL", true),
    rendererContractId,
    workerEnabled,
    workerPollMs: int(source, "CONTENT_WORKER_POLL_MS", 5_000, 1_000, 60_000),
    workerBatchSize: int(source, "CONTENT_WORKER_BATCH_SIZE", 10, 1, 100),
    workerMaxAttempts: int(source, "CONTENT_WORKER_MAX_ATTEMPTS", 8, 1, 20),
    retentionDays: int(source, "CONTENT_RETENTION_DAYS", 180, 30, 3_650),
    auditRetentionDays: int(
      source,
      "CONTENT_AUDIT_RETENTION_DAYS",
      730,
      90,
      3_650,
    ),
    dbPublicPoolMax: int(source, "CONTENT_DB_PUBLIC_POOL_MAX", 2, 1, 10),
    dbAdminPoolMax: int(source, "CONTENT_DB_ADMIN_POOL_MAX", 2, 1, 10),
    dbWorkerPoolMax: int(source, "CONTENT_DB_WORKER_POOL_MAX", 1, 1, 5),
    dbPublicStatementTimeoutMs: int(
      source,
      "CONTENT_DB_PUBLIC_STATEMENT_TIMEOUT_MS",
      750,
      100,
      10_000,
    ),
    dbAdminStatementTimeoutMs: int(
      source,
      "CONTENT_DB_ADMIN_STATEMENT_TIMEOUT_MS",
      2_500,
      250,
      15_000,
    ),
    dbWorkerStatementTimeoutMs: int(
      source,
      "CONTENT_DB_WORKER_STATEMENT_TIMEOUT_MS",
      5_000,
      500,
      30_000,
    ),
    dbLockTimeoutMs: int(source, "CONTENT_DB_LOCK_TIMEOUT_MS", 750, 100, 5_000),
    revalidateUrl,
    revalidateSecret,
    revalidateTimeoutMs: int(
      source,
      "CONTENT_REVALIDATE_TIMEOUT_MS",
      5_000,
      250,
      30_000,
    ),
    previewSecret,
    assetS3Endpoint: endpoint,
    assetS3Region,
    assetS3Bucket,
    assetS3AccessKeyId,
    assetS3SecretAccessKey,
    assetS3ForcePathStyle: bool(
      source,
      "CONTENT_ASSET_S3_FORCE_PATH_STYLE",
      Boolean(endpoint),
    ),
    assetPublicBaseUrl,
    assetUploadTtlSec: int(
      source,
      "CONTENT_ASSET_UPLOAD_TTL_SEC",
      900,
      60,
      3_600,
    ),
    assetStaticCredentialsConfigured: Boolean(
      assetS3AccessKeyId && assetS3SecretAccessKey,
    ),
    assetStorageConfigured,
  };
}
