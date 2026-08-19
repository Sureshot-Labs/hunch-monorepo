const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// Node 18+ has global fetch; keep the workspace dependency as a fallback.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const undici = require("undici");
const fetchImpl = globalThis.fetch || undici.fetch;

const DEFAULT_BASE_URL = "https://api.hunch.trade";
const DEFAULT_KEYCHAIN_SERVICE = "hunch-admin-api-codex-prod";
const DEFAULT_KEYCHAIN_ACCOUNT = "codex";
const API_KEY_PATTERN =
  /^hsa_v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const CONTENT_PATH_PREFIX = "/admin/content/";
const BOOLEAN_OPTIONS = new Set([
  "--confirm-delete",
  "--confirm-publish",
  "--confirm-restore",
  "--help",
  "-h",
]);
const VALUE_OPTIONS = new Set([
  "--alt",
  "--body",
  "--caption",
  "--credit-name",
  "--credit-url",
  "--kind",
  "--metadata",
  "--method",
  "--mime",
  "--output",
]);
const MIME_BY_EXTENSION = new Map([
  [".avif", "image/avif"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".vtt", "text/vtt"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CliError";
    this.details = details;
  }
}

class ApiError extends Error {
  constructor(status, payload, retryAfter) {
    super(`Hunch Content API returned HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.retryAfter = retryAfter || null;
  }
}

function usage() {
  console.log(
    `
Usage:
  pnpm content:api -- operations
  pnpm content:api -- request <path> [--method GET|POST|PATCH|DELETE] [--body <file|->]
  pnpm content:api -- upload <file> [--mime <type>] [--kind <kind>] [metadata options]
  pnpm content:api -- session

Request safety flags:
  --confirm-publish  Required for approve, publish, cancel-schedule, unpublish, archive
  --confirm-restore  Required for version restore
  --confirm-delete   Required for DELETE

Upload metadata options:
  --alt <text>          Default alt text
  --caption <text>      Default caption
  --credit-name <text>  Credit name
  --credit-url <url>    Credential-free HTTP(S) credit URL
  --metadata <file>     JSON object stored as asset metadata

Output option:
  --output </tmp/file>  Save JSON in a private temporary file with mode 0600

Environment overrides:
  HUNCH_ADMIN_API_BASE_URL
  HUNCH_ADMIN_API_KEYCHAIN_SERVICE
  HUNCH_ADMIN_API_KEYCHAIN_ACCOUNT
  HUNCH_CONTENT_API_TIMEOUT_MS
  HUNCH_CONTENT_UPLOAD_TIMEOUT_MS
  HUNCH_CONTENT_SESSION_IDLE_TIMEOUT_MS
  HUNCH_CONTENT_ALLOW_HTTP_LOCALHOST=1

The API key is read from macOS Keychain at runtime. It is never accepted as a
command-line argument or printed. Use an exact /admin/content/* path.

Session mode reads one JSON object per line: {"id":"1","argv":["operations"]}.
It reads Keychain once, keeps the token only in process memory, and closes after
15 minutes without input. Use {"id":"close","argv":["close"]} to exit.
`.trim(),
  );
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(value)) {
      options.set(value, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(value)) {
      throw new CliError(`Unknown option: ${value}`);
    }
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      throw new CliError(`Missing value for ${value}`);
    }
    options.set(value, next);
    index += 1;
  }

  return { positional, options };
}

function option(parsed, name) {
  return parsed.options.get(name);
}

function hasOption(parsed, name) {
  return parsed.options.has(name);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${name} must be a positive integer`);
  }
  return parsed;
}

function isLocalhost(hostname) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function validateBaseUrl(rawBaseUrl, allowHttpLocalhost = false) {
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new CliError("HUNCH_ADMIN_API_BASE_URL must be a valid URL");
  }

  if (url.username || url.password) {
    throw new CliError("HUNCH_ADMIN_API_BASE_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new CliError(
      "HUNCH_ADMIN_API_BASE_URL must not contain query or fragment data",
    );
  }
  if (url.protocol !== "https:") {
    const allowedLocalhost =
      allowHttpLocalhost &&
      url.protocol === "http:" &&
      isLocalhost(url.hostname);
    if (!allowedLocalhost) {
      throw new CliError(
        "HUNCH Content API requires HTTPS (except explicitly allowed localhost)",
      );
    }
  }
  return url;
}

function resolveContentUrl(baseUrl, rawPath) {
  if (typeof rawPath !== "string" || !rawPath.startsWith(CONTENT_PATH_PREFIX)) {
    throw new CliError(`Path must start with ${CONTENT_PATH_PREFIX}`);
  }
  if (rawPath.includes("#")) {
    throw new CliError("Content API paths must not include fragments");
  }

  const resolved = new URL(rawPath, baseUrl.origin);
  if (
    resolved.origin !== baseUrl.origin ||
    !resolved.pathname.startsWith(CONTENT_PATH_PREFIX)
  ) {
    throw new CliError(
      "Resolved URL escaped the configured Hunch Content API origin",
    );
  }
  return resolved;
}

function requiredConfirmation(method, pathname) {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "DELETE") return "--confirm-delete";
  if (
    normalizedMethod === "POST" &&
    /\/versions\/[0-9a-f-]+\/restore$/.test(pathname)
  ) {
    return "--confirm-restore";
  }
  if (
    normalizedMethod === "POST" &&
    /\/(approve|publish|cancel-schedule|unpublish|archive)$/.test(pathname)
  ) {
    return "--confirm-publish";
  }
  return null;
}

function readKeychainApiKey({ service, account }) {
  if (process.platform !== "darwin") {
    throw new CliError("The Keychain-backed helper currently requires macOS");
  }

  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    {
      encoding: "utf8",
      maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    throw new CliError(
      `Unable to read Keychain item service=${service} account=${account}. ` +
        "Approve the macOS prompt with Allow Once and retry.",
    );
  }

  const token = result.stdout.trim();
  if (!API_KEY_PATTERN.test(token)) {
    throw new CliError(
      "The Keychain item does not contain a valid Hunch admin service token",
    );
  }
  return token;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonSource(source, label) {
  if (!source) throw new CliError(`${label} requires a JSON source`);
  let text;
  try {
    text =
      source === "-"
        ? await readStdin()
        : fs.readFileSync(path.resolve(source), "utf8");
  } catch {
    throw new CliError(`Unable to read ${label} JSON source`);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(`${label} must contain valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`${label} must be a JSON object`);
  }
  return value;
}

function safeApiErrorPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const safe = {};
  if (typeof value.error === "string") safe.error = value.error;
  if (typeof value.message === "string") safe.message = value.message;
  if (Array.isArray(value.issues)) safe.issues = value.issues;
  return Object.keys(safe).length > 0 ? safe : null;
}

function createApiClient({ baseUrl, token, timeoutMs }) {
  return {
    async request(method, rawPath, body) {
      const url = resolveContentUrl(baseUrl, rawPath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      let response;
      let responseText;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        });
        responseText = await response.text();
      } catch {
        throw new CliError(
          "Hunch Content API request failed before a response was received",
        );
      } finally {
        clearTimeout(timeout);
      }

      let payload = null;
      if (responseText) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          if (response.ok) {
            throw new CliError(
              "Hunch Content API returned a non-JSON success response",
            );
          }
        }
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          safeApiErrorPayload(payload),
          response.headers.get("retry-after"),
        );
      }
      if (!payload || typeof payload !== "object") {
        throw new CliError(
          "Hunch Content API returned an empty success response",
        );
      }
      return payload;
    },
  };
}

function inferMimeType(filePath) {
  return MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) || null;
}

function inferAssetKind(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function validateCreditUrl(rawUrl) {
  if (!rawUrl) return undefined;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError("--credit-url must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new CliError("--credit-url must be credential-free HTTP(S)");
  }
  return url.toString();
}

function validateOutputPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new CliError("--output requires a path below /tmp");
  }
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith("/tmp/") && !resolved.startsWith("/private/tmp/")) {
    throw new CliError("--output is restricted to /tmp");
  }
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    throw new CliError("--output parent directory must already exist");
  }
  const temporaryRoots = ["/tmp", "/private/tmp"].map((root) =>
    fs.realpathSync(root),
  );
  if (
    !temporaryRoots.some(
      (root) => realParent === root || realParent.startsWith(`${root}/`),
    )
  ) {
    throw new CliError("--output is restricted to /tmp");
  }
  return resolved;
}

function reserveJsonOutput(rawPath) {
  const outputPath = validateOutputPath(rawPath);
  try {
    const descriptor = fs.openSync(outputPath, "wx", 0o600);
    fs.closeSync(descriptor);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new CliError("--output refuses to overwrite an existing file");
    }
    throw new CliError("Unable to reserve --output JSON file");
  }
  return outputPath;
}

function releaseJsonOutput(outputPath) {
  if (!outputPath) return;
  try {
    fs.unlinkSync(outputPath);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw new CliError("Unable to release --output JSON file");
    }
  }
}

function persistJsonResult(outputPath, value) {
  try {
    fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
  } catch (error) {
    releaseJsonOutput(outputPath);
    throw new CliError("Unable to write --output JSON file");
  }
  return { ok: true, savedTo: outputPath };
}

async function uploadAsset(getClient, parsed, uploadTimeoutMs) {
  const fileArg = parsed.positional[1];
  if (!fileArg) throw new CliError("upload requires a file path");
  const filePath = path.resolve(fileArg);

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    throw new CliError("Unable to read upload file");
  }
  if (bytes.length === 0) throw new CliError("Upload file must not be empty");

  const mimeType = option(parsed, "--mime") || inferMimeType(filePath);
  if (!mimeType)
    throw new CliError("Unable to infer MIME type; pass --mime explicitly");
  const kind = option(parsed, "--kind") || inferAssetKind(mimeType);
  if (!["image", "video", "audio", "file"].includes(kind)) {
    throw new CliError("--kind must be image, video, audio, or file");
  }

  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const metadataSource = option(parsed, "--metadata");
  const metadata = metadataSource
    ? await readJsonSource(metadataSource, "--metadata")
    : undefined;
  const createBody = {
    kind,
    originalFilename: path.basename(filePath),
    mimeType,
    expectedByteSize: bytes.length,
    checksumSha256,
    ...(option(parsed, "--alt") !== undefined
      ? { defaultAlt: option(parsed, "--alt") }
      : {}),
    ...(option(parsed, "--caption") !== undefined
      ? { defaultCaption: option(parsed, "--caption") }
      : {}),
    ...(option(parsed, "--credit-name") !== undefined
      ? { creditName: option(parsed, "--credit-name") }
      : {}),
    ...(option(parsed, "--credit-url") !== undefined
      ? { creditUrl: validateCreditUrl(option(parsed, "--credit-url")) }
      : {}),
    ...(metadata ? { metadata } : {}),
  };

  const client = getClient();
  const intent = await client.request(
    "POST",
    "/admin/content/assets",
    createBody,
  );
  const assetId = intent?.asset?.id;
  const upload = intent?.upload;
  if (
    typeof assetId !== "string" ||
    !upload ||
    upload.method !== "PUT" ||
    typeof upload.url !== "string" ||
    !upload.headers ||
    typeof upload.headers !== "object"
  ) {
    throw new CliError("Asset intent response was incomplete", {
      stage: "intent",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);
  let uploadResponse;
  try {
    uploadResponse = await fetchImpl(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: bytes,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new CliError("Asset upload failed before storage acknowledged it", {
      assetId,
      stage: "upload",
      outcome: "ambiguous",
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!uploadResponse.ok) {
    throw new CliError("Asset storage rejected the upload", {
      assetId,
      stage: "upload",
      status: uploadResponse.status,
    });
  }

  try {
    return await client.request(
      "POST",
      `/admin/content/assets/${encodeURIComponent(assetId)}/complete`,
      { byteSize: bytes.length, checksumSha256 },
    );
  } catch (error) {
    if (error instanceof ApiError || error instanceof CliError) {
      error.details = { ...(error.details || {}), assetId, stage: "complete" };
    }
    throw error;
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorPayload(error) {
  if (error instanceof ApiError) {
    return {
      ok: false,
      status: error.status,
      ...(error.payload || { error: "content_api_request_failed" }),
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof CliError) {
    return {
      ok: false,
      error: "content_api_cli_error",
      message: error.message,
      ...(Object.keys(error.details || {}).length > 0
        ? { details: error.details }
        : {}),
    };
  }
  return {
    ok: false,
    error: "content_api_cli_unexpected_error",
    message: "Unexpected local helper failure",
  };
}

function printError(error) {
  printJson(errorPayload(error));
}

function parseSessionEnvelope(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CliError("Session input must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Session input must be a JSON object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "argv"].includes(key))) {
    throw new CliError("Session input only accepts id and argv");
  }
  if (
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 100
  ) {
    throw new CliError("Session id must be a string between 1 and 100 chars");
  }
  if (
    !Array.isArray(value.argv) ||
    value.argv.length < 1 ||
    value.argv.length > 100 ||
    value.argv.some((part) => typeof part !== "string" || part.length > 10_000)
  ) {
    throw new CliError("Session argv must be a non-empty string array");
  }
  return { id: value.id, argv: value.argv };
}

async function executeParsedCommand(
  parsed,
  { baseUrl, getClient, uploadTimeoutMs, sessionMode = false },
) {
  const command = parsed.positional[0];
  if (!command) throw new CliError("A content API command is required");
  if (!["operations", "request", "upload"].includes(command)) {
    throw new CliError(`Unknown command: ${command}`);
  }

  if (command === "operations") {
    return getClient().request("GET", "/admin/content/operations");
  }

  if (command === "upload") {
    return uploadAsset(getClient, parsed, uploadTimeoutMs);
  }

  const rawPath = parsed.positional[1];
  if (!rawPath) throw new CliError("request requires an /admin/content/* path");
  const method = String(option(parsed, "--method") || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) {
    throw new CliError("--method must be GET, POST, PATCH, or DELETE");
  }
  const url = resolveContentUrl(baseUrl, rawPath);
  const confirmation = requiredConfirmation(method, url.pathname);
  if (confirmation && !hasOption(parsed, confirmation)) {
    throw new CliError(`${method} ${url.pathname} requires ${confirmation}`);
  }
  if (method === "POST" && url.pathname === "/admin/content/assets") {
    throw new CliError(
      "Use the upload command so signed storage URLs remain private",
    );
  }

  const bodySource = option(parsed, "--body");
  if (method === "GET" && bodySource) {
    throw new CliError("GET requests must not include --body");
  }
  if (sessionMode && bodySource === "-") {
    throw new CliError(
      "Session requests must read --body from a file because stdin carries commands",
    );
  }
  const body = bodySource
    ? await readJsonSource(bodySource, "--body")
    : undefined;
  return getClient().request(method, rawPath, body);
}

async function runSession({ baseUrl, client, idleTimeoutMs, uploadTimeoutMs }) {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  let idleTimer;
  let timedOut = false;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      input.close();
    }, idleTimeoutMs);
    idleTimer.unref();
  };
  const writeLine = (value) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  writeLine({
    ok: true,
    session: { state: "ready", idleTimeoutMs },
  });
  resetIdleTimer();
  for await (const rawLine of input) {
    resetIdleTimer();
    const line = rawLine.trim();
    if (!line) continue;
    let envelope;
    try {
      envelope = parseSessionEnvelope(line);
      if (envelope.argv[0] === "close") {
        writeLine({
          ok: true,
          sessionRequestId: envelope.id,
          session: { state: "closing" },
        });
        break;
      }
      if (envelope.argv[0] === "session") {
        throw new CliError("Nested content API sessions are not allowed");
      }
      const commandArgs = parseArgs(envelope.argv);
      const rawOutputPath = option(commandArgs, "--output");
      const outputPath = rawOutputPath
        ? reserveJsonOutput(rawOutputPath)
        : null;
      let result;
      try {
        result = await executeParsedCommand(commandArgs, {
          baseUrl,
          getClient: () => client,
          uploadTimeoutMs,
          sessionMode: true,
        });
      } catch (error) {
        releaseJsonOutput(outputPath);
        throw error;
      }
      writeLine({
        ok: true,
        sessionRequestId: envelope.id,
        result: outputPath ? persistJsonResult(outputPath, result) : result,
      });
    } catch (error) {
      writeLine({
        sessionRequestId: envelope?.id ?? null,
        ...errorPayload(error),
      });
    }
  }
  clearTimeout(idleTimer);
  writeLine({
    ok: true,
    session: { state: "closed", reason: timedOut ? "idle_timeout" : "client" },
  });
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (
    hasOption(parsed, "--help") ||
    hasOption(parsed, "-h") ||
    !parsed.positional[0]
  ) {
    usage();
    return;
  }

  const command = parsed.positional[0];
  if (!["operations", "request", "session", "upload"].includes(command)) {
    throw new CliError(`Unknown command: ${command}`);
  }

  const allowHttpLocalhost =
    process.env.HUNCH_CONTENT_ALLOW_HTTP_LOCALHOST === "1";
  const baseUrl = validateBaseUrl(
    process.env.HUNCH_ADMIN_API_BASE_URL || DEFAULT_BASE_URL,
    allowHttpLocalhost,
  );
  const timeoutMs = positiveInteger(
    process.env.HUNCH_CONTENT_API_TIMEOUT_MS,
    30_000,
    "HUNCH_CONTENT_API_TIMEOUT_MS",
  );
  const uploadTimeoutMs = positiveInteger(
    process.env.HUNCH_CONTENT_UPLOAD_TIMEOUT_MS,
    120_000,
    "HUNCH_CONTENT_UPLOAD_TIMEOUT_MS",
  );
  const sessionIdleTimeoutMs = positiveInteger(
    process.env.HUNCH_CONTENT_SESSION_IDLE_TIMEOUT_MS,
    900_000,
    "HUNCH_CONTENT_SESSION_IDLE_TIMEOUT_MS",
  );
  const getClient = () => {
    const token = readKeychainApiKey({
      service:
        process.env.HUNCH_ADMIN_API_KEYCHAIN_SERVICE ||
        DEFAULT_KEYCHAIN_SERVICE,
      account:
        process.env.HUNCH_ADMIN_API_KEYCHAIN_ACCOUNT ||
        DEFAULT_KEYCHAIN_ACCOUNT,
    });
    return createApiClient({ baseUrl, token, timeoutMs });
  };

  if (command === "session") {
    const client = getClient();
    await runSession({
      baseUrl,
      client,
      idleTimeoutMs: sessionIdleTimeoutMs,
      uploadTimeoutMs,
    });
    return;
  }
  const rawOutputPath = option(parsed, "--output");
  const outputPath = rawOutputPath ? reserveJsonOutput(rawOutputPath) : null;
  let result;
  try {
    result = await executeParsedCommand(parsed, {
      baseUrl,
      getClient,
      uploadTimeoutMs,
    });
  } catch (error) {
    releaseJsonOutput(outputPath);
    throw error;
  }
  printJson(outputPath ? persistJsonResult(outputPath, result) : result);
}

if (require.main === module) {
  main().catch((error) => {
    printError(error);
    process.exitCode = 1;
  });
}

module.exports = {
  API_KEY_PATTERN,
  inferAssetKind,
  inferMimeType,
  parseArgs,
  parseSessionEnvelope,
  releaseJsonOutput,
  reserveJsonOutput,
  requiredConfirmation,
  resolveContentUrl,
  safeApiErrorPayload,
  validateBaseUrl,
  validateOutputPath,
};
