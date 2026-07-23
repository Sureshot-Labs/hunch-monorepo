import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config as dotenv, parse as parseDotenv } from "dotenv";

export type SecretsMode = "off" | "optional" | "strict";

type Logger = Pick<typeof console, "info" | "warn" | "error">;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SecretBundleRef = {
  provider: "aws-sm";
  secretId: string;
};

export type LoadRuntimeSecretsOptions = {
  envPath?: string;
  logger?: Logger;
  fetchImpl?: FetchLike;
  now?: Date;
};

export type LoadRuntimeSecretsResult = {
  mode: SecretsMode;
  envLoaded: boolean;
  bundles: string[];
  keysLoaded: string[];
  skipped: boolean;
};

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type BundleName =
  | "shared"
  | "api"
  | "polymarket-builder"
  | "rewards"
  | "ai"
  | "indexer-dflow"
  | "indexer-limitless"
  | "ops"
  | "signal-bot";

export const SECRET_BUNDLE_KEYS: Record<BundleName, readonly string[]> = {
  shared: [
    "DATABASE_URL",
    "REDIS_URL",
    "CREDENTIALS_ENCRYPTION_KEY",
    "FUNDING_REFERENCE_LOOKUP_HMAC_KEY",
    "JWT_SECRET",
    "HUNCH_PROXY_SECRET",
    "POLYGON_RPC_URL",
    "HUNCH_POLYGON_RPC_URL",
    "BASE_RPC_URL",
    "SOLANA_RPC_URL",
    "HUNCH_SOLANA_RPC_URL",
    "SOLANA_RPC_URLS",
    "ETHEREUM_RPC_URL",
    "ARBITRUM_RPC_URL",
    "AVALANCHE_RPC_URL",
    "BSC_RPC_URL",
    "LINEA_RPC_URL",
    "OPTIMISM_RPC_URL",
    "EVM_RPC_URLS_BY_CHAIN",
    "ALCHEMY_POLYGON_NFT_BASE_URL",
    "ALCHEMY_BASE_NFT_BASE_URL",
  ],
  api: [
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_WALLET_AUTHORIZATION_ID",
    "PRIVY_WALLET_AUTHORIZATION_KEY",
    "PRIVY_POLYMARKET_BOT_BUY_POLICY_ID",
    "PRIVY_POLYMARKET_BOT_SELL_POLICY_ID",
    "PRIVY_POLYMARKET_BOT_BUY_SELL_POLICY_ID",
    "PRIVY_POLYMARKET_BOT_BUY_POLICY_MAX_USD",
    "PRIVY_WEBHOOK_SECRET",
    "METRICS_AUTH_TOKEN",
    "DFLOW_API_KEY",
    "LIMITLESS_HMAC_TOKEN_ID",
    "LIMITLESS_HMAC_SECRET",
    "ACROSS_API_KEY",
    "RELAY_API_KEY",
    "HUNCH_TELEGRAM_BOT_TOKEN",
    "HUNCH_SIGNAL_BOT_INTERNAL_API_TOKEN",
    "XAI_API_KEY",
    "XAI_MANAGEMENT_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_KEY",
  ],
  "polymarket-builder": [
    "POLYMARKET_BUILDER_API_KEY",
    "POLYMARKET_BUILDER_API_SECRET",
    "POLYMARKET_BUILDER_API_PASSPHRASE",
    "POLYMARKET_RELAYER_API_KEY",
    "POLYMARKET_RELAYER_PRIVATE_KEY",
  ],
  rewards: [
    "HUNCH_FEE_COLLECTOR_PRIVATE_KEY",
    "HUNCH_FEE_COLLECTOR_LEGACY_PRIVATE_KEY",
    "HUNCH_REWARDS_PAYOUT_PRIVATE_KEY",
    "HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_POLYGON",
    "HUNCH_REWARDS_PAYOUT_PRIVATE_KEY_BASE",
    "HUNCH_REWARDS_SOLANA_SECRET_KEY",
  ],
  ai: ["OPENROUTER_API_KEY", "XAI_API_KEY", "XAI_MANAGEMENT_API_KEY"],
  "indexer-dflow": ["DFLOW_API_KEY"],
  "indexer-limitless": ["LIMITLESS_WS_SESSION"],
  ops: [
    "AGG_APP_ID",
    "AGG_API_KEY",
    "AGG_HMAC_SIGNING_KEY",
    "OPINIONLABS_API_KEY",
    "POLYMARKET_L2_API_KEY",
    "POLYMARKET_L2_API_SECRET",
    "POLYMARKET_L2_API_PASSPHRASE",
    "LIMITLESS_API_KEY",
    "LIMITLESS_SESSION",
    "POLYGON_DEPLOYER_KEY",
  ],
  "signal-bot": [
    "HUNCH_SIGNAL_BOT_ADMIN_USER_IDS",
    "HUNCH_SIGNAL_BOT_INTERNAL_API_TOKEN",
    "HUNCH_SIGNAL_BOT_TOKEN",
  ],
};

const DEFAULT_SECRET_PREFIX = "/hunch/prod";

function normalizeMode(raw: string | undefined): SecretsMode {
  const value = raw?.trim().toLowerCase();
  if (value === "optional" || value === "strict" || value === "off") {
    return value;
  }
  return "off";
}

export function parseSecretBundleRefs(
  raw: string | undefined,
): SecretBundleRef[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const secretId = entry.startsWith("aws-sm:")
        ? entry.slice("aws-sm:".length)
        : entry;
      if (!secretId) {
        throw new Error("[secrets] Empty AWS Secrets Manager ref");
      }
      return { provider: "aws-sm", secretId };
    });
}

export function loadEnvFile(
  envPath: string,
  options: { override?: boolean } = {},
): boolean {
  if (!fs.existsSync(envPath)) return false;
  dotenv({ path: envPath, override: options.override ?? true });
  return true;
}

export function loadEnvFileUnlessRuntimeSecretsLoaded(
  envPath: string,
): boolean {
  if (process.env.HUNCH_RUNTIME_SECRETS_LOADED === "1") return false;
  return loadEnvFile(envPath, { override: true });
}

export async function loadRuntimeSecrets(
  options: LoadRuntimeSecretsOptions = {},
): Promise<LoadRuntimeSecretsResult> {
  const logger = options.logger ?? console;
  const envPath = options.envPath ?? path.resolve(process.cwd(), ".env");
  const runtimeOverrides = captureRuntimeOverrides([
    "HUNCH_SECRETS_MODE",
    "HUNCH_SECRET_BUNDLES",
    "HUNCH_SECRET_REQUIRED_KEYS",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ]);
  const envLoaded = loadEnvFile(envPath, { override: true });
  restoreRuntimeOverrides(runtimeOverrides);
  const mode = normalizeMode(process.env.HUNCH_SECRETS_MODE);
  const refs = parseSecretBundleRefs(process.env.HUNCH_SECRET_BUNDLES);

  if (mode === "off") {
    if (refs.length > 0) {
      logger.info(
        `[secrets] mode=off; ignoring configured bundles: ${refs
          .map((ref) => ref.secretId)
          .join(", ")}`,
      );
    }
    process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
    return {
      mode,
      envLoaded,
      bundles: [],
      keysLoaded: [],
      skipped: true,
    };
  }

  if (refs.length === 0) {
    const message =
      "[secrets] HUNCH_SECRET_BUNDLES is empty; using existing environment";
    if (mode === "strict") throw new Error(message);
    logger.warn(message);
    process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
    return {
      mode,
      envLoaded,
      bundles: [],
      keysLoaded: [],
      skipped: true,
    };
  }

  const loadedKeys = new Set<string>();
  const loadedBundles: string[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const loadedValues: Record<string, string> = {};
    for (const ref of refs) {
      const bundle = await getAwsSecretJson(ref.secretId, {
        fetchImpl,
        now: options.now,
      });
      loadedBundles.push(ref.secretId);
      for (const [key, value] of Object.entries(bundle)) {
        if (typeof value !== "string") {
          throw new Error(
            `[secrets] ${ref.secretId} key ${key} must be a string value`,
          );
        }
        if (loadedKeys.has(key)) {
          logger.warn(
            `[secrets] key ${key} was provided by multiple bundles; later bundle ${ref.secretId} wins`,
          );
        }
        loadedValues[key] = value;
        loadedKeys.add(key);
      }
      logger.info(
        `[secrets] loaded ${Object.keys(bundle).length} keys from ${ref.secretId}: ${Object.keys(
          bundle,
        )
          .sort()
          .join(", ")}`,
      );
    }

    Object.assign(process.env, loadedValues);
    validateRequiredSecrets(process.env.HUNCH_SECRET_REQUIRED_KEYS);
    process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
    return {
      mode,
      envLoaded,
      bundles: loadedBundles,
      keysLoaded: [...loadedKeys].sort(),
      skipped: false,
    };
  } catch (error) {
    if (mode === "strict") throw error;
    logger.error(
      `[secrets] optional mode failed; using existing environment fallback: ${describeError(
        error,
      )}`,
    );
    process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
    return {
      mode,
      envLoaded,
      bundles: loadedBundles,
      keysLoaded: [...loadedKeys].sort(),
      skipped: true,
    };
  }
}

function captureRuntimeOverrides(keys: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = process.env[key];
    if (value != null && value.trim().length > 0) values.set(key, value);
  }
  return values;
}

function restoreRuntimeOverrides(values: Map<string, string>): void {
  for (const [key, value] of values) process.env[key] = value;
}

function validateRequiredSecrets(raw: string | undefined): void {
  const keys = (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `[secrets] Missing required secrets: ${missing.join(", ")}`,
    );
  }
}

async function getAwsSecretJson(
  secretId: string,
  options: { fetchImpl: FetchLike; now?: Date },
): Promise<Record<string, string>> {
  const region = resolveAwsRegion();
  const credentials = await resolveAwsCredentials(options.fetchImpl);
  const body = JSON.stringify({ SecretId: secretId });
  const res = await signedAwsJsonRequest({
    body,
    credentials,
    fetchImpl: options.fetchImpl,
    now: options.now ?? new Date(),
    region,
    service: "secretsmanager",
    target: "secretsmanager.GetSecretValue",
  });
  const payload = (await res.json()) as {
    SecretString?: string;
    message?: string;
    Message?: string;
    __type?: string;
  };
  if (!res.ok) {
    const errorMessage = payload.message ?? payload.Message ?? res.statusText;
    const errorType = payload.__type ? `${payload.__type}: ` : "";
    throw new Error(
      `[secrets] GetSecretValue failed for ${secretId}: ${errorType}${errorMessage}`,
    );
  }
  if (!payload.SecretString) {
    throw new Error(`[secrets] ${secretId} did not return SecretString`);
  }
  const parsed = JSON.parse(payload.SecretString) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[secrets] ${secretId} SecretString must be a JSON object`);
  }
  return parsed as Record<string, string>;
}

function resolveAwsRegion(): string {
  const region =
    process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  if (!region) {
    throw new Error("[secrets] Missing AWS_REGION or AWS_DEFAULT_REGION");
  }
  return region;
}

async function resolveAwsCredentials(
  fetchImpl: FetchLike,
): Promise<AwsCredentials> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
    };
  }

  const ecs = await tryResolveEcsCredentials(fetchImpl);
  if (ecs) return ecs;

  return resolveImdsCredentials(fetchImpl);
}

async function tryResolveEcsCredentials(
  fetchImpl: FetchLike,
): Promise<AwsCredentials | null> {
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  const relativeUri =
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  const url = fullUri
    ? fullUri
    : relativeUri
      ? `http://169.254.170.2${relativeUri}`
      : "";
  if (!url) return null;
  const headers: Record<string, string> = {};
  const tokenFile =
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim() || "";
  const token = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
  if (token) headers.Authorization = token;
  if (tokenFile && fs.existsSync(tokenFile)) {
    headers.Authorization = fs.readFileSync(tokenFile, "utf8").trim();
  }
  const response = await fetchJson<{
    AccessKeyId: string;
    SecretAccessKey: string;
    Token?: string;
  }>(fetchImpl, url, { headers });
  return {
    accessKeyId: response.AccessKeyId,
    secretAccessKey: response.SecretAccessKey,
    sessionToken: response.Token,
  };
}

async function resolveImdsCredentials(
  fetchImpl: FetchLike,
): Promise<AwsCredentials> {
  const endpoint =
    process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.trim() ||
    "http://169.254.169.254";
  const tokenRes = await fetchImpl(`${endpoint}/latest/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
  });
  if (!tokenRes.ok) {
    throw new Error(
      `[secrets] IMDS token request failed: ${tokenRes.status} ${tokenRes.statusText}`,
    );
  }
  const token = await tokenRes.text();
  const metadataHeaders = { "x-aws-ec2-metadata-token": token };
  const roleName = (
    await textOrThrow(
      fetchImpl,
      `${endpoint}/latest/meta-data/iam/security-credentials/`,
      { headers: metadataHeaders },
    )
  ).trim();
  if (!roleName) throw new Error("[secrets] IMDS returned empty role name");
  const credentials = await fetchJson<{
    AccessKeyId: string;
    SecretAccessKey: string;
    Token?: string;
  }>(
    fetchImpl,
    `${endpoint}/latest/meta-data/iam/security-credentials/${roleName}`,
    { headers: metadataHeaders },
  );
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.Token,
  };
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`[secrets] fetch failed ${url}: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function textOrThrow(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`[secrets] fetch failed ${url}: ${res.status}`);
  }
  return res.text();
}

async function signedAwsJsonRequest(inputs: {
  body: string;
  credentials: AwsCredentials;
  fetchImpl: FetchLike;
  now: Date;
  region: string;
  service: string;
  target: string;
}): Promise<Response> {
  const host = `${inputs.service}.${inputs.region}.amazonaws.com`;
  const amzDate = toAmzDate(inputs.now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": inputs.target,
  };
  if (inputs.credentials.sessionToken) {
    headers["x-amz-security-token"] = inputs.credentials.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(inputs.body),
  ].join("\n");
  const scope = `${dateStamp}/${inputs.region}/${inputs.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(
    inputs.credentials.secretAccessKey,
    dateStamp,
    inputs.region,
    inputs.service,
  );
  const signature = hmacHex(signingKey, stringToSign);
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${inputs.credentials.accessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return inputs.fetchImpl(`https://${host}/`, {
    method: "POST",
    headers,
    body: inputs.body,
  });
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key: crypto.BinaryLike, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: crypto.BinaryLike, value: string): string {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Buffer {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type BuildSecretBundlesOptions = {
  envPath: string;
  outDir: string;
  profile?: string;
  force?: boolean;
  dryRun?: boolean;
  awsCliCommands?: boolean;
  logger?: Logger;
};

export type BuildSecretBundlesResult = {
  bundles: Record<string, string[]>;
  sanitizedEnvPath: string;
  awsCliCommands: string[];
  awsCliCreateCommands: string[];
};

export function buildSecretBundles(
  options: BuildSecretBundlesOptions,
): BuildSecretBundlesResult {
  const logger = options.logger ?? console;
  const profile = options.profile ?? "prod";
  const prefix = `/hunch/${profile}`;
  const raw = fs.readFileSync(options.envPath, "utf8");
  const parsed = parseDotenv(raw);
  const bundles: Record<BundleName, Record<string, string>> = {
    shared: {},
    api: {},
    "polymarket-builder": {},
    rewards: {},
    ai: {},
    "indexer-dflow": {},
    "indexer-limitless": {},
    ops: {},
    "signal-bot": {},
  };

  for (const [key, value] of Object.entries(parsed)) {
    const targetBundles = findBundlesForSecretKey(key);
    const detectedBundle =
      targetBundles.length > 0 ? null : detectSensitiveUrlBundle(key, value);
    const bundleNames =
      targetBundles.length > 0
        ? targetBundles
        : detectedBundle
          ? [detectedBundle]
          : [];
    for (const bundle of bundleNames) {
      bundles[bundle][key] = value;
    }
  }

  const activeBundles = Object.entries(bundles).filter(
    ([, values]) => Object.keys(values).length > 0,
  ) as Array<[BundleName, Record<string, string>]>;
  const outDir = path.resolve(options.outDir);
  const sanitizedEnvPath = path.join(outDir, "env-with-secret-refs");
  const bundleRefs = activeBundles
    .map(([name]) => `aws-sm:${prefix}/${name}`)
    .join(",");
  const bundledSecretKeys = new Set(
    activeBundles.flatMap(([, values]) => Object.keys(values)),
  );
  const knownSecretKeys = new Set([
    ...bundledSecretKeys,
    ...Object.values(SECRET_BUNDLE_KEYS).flat(),
  ]);
  const sanitized = sanitizeEnv(raw, knownSecretKeys, {
    profile,
    bundleRefs,
  });
  const commands = activeBundles.map(
    ([name]) =>
      `aws secretsmanager put-secret-value --secret-id ${prefix}/${name} --secret-string file://${path.join(
        outDir,
        `${name}.json`,
      )}`,
  );
  const createCommands = activeBundles.map(
    ([name]) =>
      `aws secretsmanager create-secret --name ${prefix}/${name} --kms-key-id alias/hunch-prod-secrets --secret-string file://${path.join(
        outDir,
        `${name}.json`,
      )}`,
  );

  const summary = Object.fromEntries(
    activeBundles.map(([name, values]) => [name, Object.keys(values).sort()]),
  );

  if (options.dryRun) {
    logger.info(`[secrets] dry run for ${options.envPath}`);
    for (const [name, keys] of Object.entries(summary)) {
      logger.info(`[secrets] ${name}: ${keys.join(", ")}`);
    }
    if (options.awsCliCommands) {
      logger.info("# First-time creation:");
      for (const command of createCommands) logger.info(command);
      logger.info("# Updates after a secret already exists:");
      for (const command of commands) logger.info(command);
    }
    return {
      bundles: summary,
      sanitizedEnvPath,
      awsCliCommands: commands,
      awsCliCreateCommands: createCommands,
    };
  }

  if (fs.existsSync(outDir) && !options.force) {
    const existing = fs.readdirSync(outDir);
    if (existing.length > 0) {
      throw new Error(
        `[secrets] output directory ${outDir} is not empty; use --force to overwrite`,
      );
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, values] of activeBundles) {
    writeSecretFile(path.join(outDir, `${name}.json`), values);
  }
  writeSecretFile(sanitizedEnvPath, sanitized, false);
  if (options.awsCliCommands) {
    fs.writeFileSync(
      path.join(outDir, "aws-cli-commands.txt"),
      [
        "# First-time creation:",
        ...createCommands,
        "",
        "# Updates after a secret already exists:",
        ...commands,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  return {
    bundles: summary,
    sanitizedEnvPath,
    awsCliCommands: commands,
    awsCliCreateCommands: createCommands,
  };
}

function findBundlesForSecretKey(key: string): BundleName[] {
  return (Object.keys(SECRET_BUNDLE_KEYS) as BundleName[]).filter((bundle) =>
    SECRET_BUNDLE_KEYS[bundle].includes(key),
  );
}

function detectSensitiveUrlBundle(
  key: string,
  value: string,
): BundleName | null {
  if (key.startsWith("NEXT_PUBLIC_")) return null;
  if (!/(RPC_URL|RPC_URLS|BASE_URL)$/u.test(key)) return null;
  if (
    /(alchemy|infura|quicknode|ankr|drpc|blastapi|helius|triton|figment)/iu.test(
      value,
    ) ||
    /[?&](api[-_]?key|apikey|token|auth)=/iu.test(value)
  ) {
    return "shared";
  }
  return null;
}

function sanitizeEnv(
  raw: string,
  secretKeys: Set<string>,
  options: { profile: string; bundleRefs: string },
): string {
  const output: string[] = [];
  let sawMode = false;
  let sawBundles = false;
  for (const line of raw.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    const commentedMatch = line.match(/^\s*#+\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (match && secretKeys.has(match[1])) continue;
    if (commentedMatch && secretKeys.has(commentedMatch[1])) continue;
    if (match?.[1] === "HUNCH_SECRETS_MODE") {
      sawMode = true;
      output.push("HUNCH_SECRETS_MODE=optional");
      continue;
    }
    if (match?.[1] === "HUNCH_SECRET_BUNDLES") {
      sawBundles = true;
      output.push(`HUNCH_SECRET_BUNDLES=${options.bundleRefs}`);
      continue;
    }
    output.push(line);
  }
  if (!sawMode) output.push("HUNCH_SECRETS_MODE=optional");
  if (!sawBundles) output.push(`HUNCH_SECRET_BUNDLES=${options.bundleRefs}`);
  output.push(`HUNCH_SECRET_PROFILE=${options.profile}`);
  return `${output.join("\n").replace(/\n+$/u, "")}\n`;
}

function writeSecretFile(
  filePath: string,
  payload: Record<string, string> | string,
  json = true,
): void {
  const content = json
    ? `${JSON.stringify(payload, null, 2)}\n`
    : String(payload);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export function defaultBundleRefs(profile = "prod"): string {
  return (Object.keys(SECRET_BUNDLE_KEYS) as BundleName[])
    .map(
      (name) =>
        `aws-sm:${DEFAULT_SECRET_PREFIX.replace("/prod", `/${profile}`)}/${name}`,
    )
    .join(",");
}
