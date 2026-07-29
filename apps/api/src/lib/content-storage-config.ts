export type ContentStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  staticCredentialsConfigured: boolean;
  storageConfigured: boolean;
};

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function httpUrl(name: string, value: string, production: boolean): void {
  if (!value) return;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[env] ${name} must be an HTTP(S) URL`);
  }
  if (production && parsed.protocol !== "https:") {
    throw new Error(`[env] ${name} must use HTTPS in production`);
  }
}

export function resolveContentStorageConfig(
  source: NodeJS.ProcessEnv,
  nodeEnv: string,
): ContentStorageConfig {
  const endpoint =
    source.CONTENT_ASSET_S3_ENDPOINT?.trim().replace(/\/+$/, "") || "";
  const explicitRegion = source.CONTENT_ASSET_S3_REGION?.trim() || "";
  const awsRegion =
    source.AWS_REGION?.trim() || source.AWS_DEFAULT_REGION?.trim() || "";
  const region =
    !endpoint && explicitRegion.toLowerCase() === "auto"
      ? awsRegion || "us-east-1"
      : explicitRegion || awsRegion || (endpoint ? "auto" : "us-east-1");
  const bucket = source.CONTENT_ASSET_S3_BUCKET?.trim() || "";
  const accessKeyId = source.CONTENT_ASSET_S3_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey =
    source.CONTENT_ASSET_S3_SECRET_ACCESS_KEY?.trim() || "";
  const publicBaseUrl =
    source.CONTENT_ASSET_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "";
  const forcePathStyle =
    optionalBoolean(source.CONTENT_ASSET_S3_FORCE_PATH_STYLE) ??
    Boolean(endpoint);

  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "[env] CONTENT_ASSET_S3_ACCESS_KEY_ID and CONTENT_ASSET_S3_SECRET_ACCESS_KEY must be configured together",
    );
  }

  const staticCredentialsConfigured = Boolean(accessKeyId && secretAccessKey);
  const storageConfigured = Boolean(bucket && publicBaseUrl);
  const storageRequested = Boolean(
    endpoint || bucket || accessKeyId || secretAccessKey || publicBaseUrl,
  );
  if (storageRequested && !storageConfigured) {
    throw new Error(
      "[env] CONTENT_ASSET_S3_BUCKET and CONTENT_ASSET_PUBLIC_BASE_URL are required for content object storage; endpoint and a paired access-key/secret are optional when the AWS default credential chain is available",
    );
  }

  const production = nodeEnv.toLowerCase() === "production";
  httpUrl("CONTENT_ASSET_S3_ENDPOINT", endpoint, production);
  httpUrl("CONTENT_ASSET_PUBLIC_BASE_URL", publicBaseUrl, production);

  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl,
    forcePathStyle,
    staticCredentialsConfigured,
    storageConfigured,
  };
}
