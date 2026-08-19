const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
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
} = require("./hunch-content-api.js");

test("accepts the production service token format", () => {
  const token = `hsa_v1.123e4567-e89b-12d3-a456-426614174000.${"A".repeat(43)}`;
  assert.equal(API_KEY_PATTERN.test(token), true);
  assert.equal(API_KEY_PATTERN.test("hsa_v1.malformed"), false);
});

test("requires HTTPS except explicitly allowed localhost", () => {
  assert.equal(
    validateBaseUrl("https://api.hunch.trade").origin,
    "https://api.hunch.trade",
  );
  assert.throws(
    () => validateBaseUrl("http://api.hunch.trade"),
    /requires HTTPS/,
  );
  assert.throws(
    () => validateBaseUrl("http://127.0.0.1:3001"),
    /requires HTTPS/,
  );
  assert.equal(
    validateBaseUrl("http://127.0.0.1:3001", true).origin,
    "http://127.0.0.1:3001",
  );
  assert.throws(
    () => validateBaseUrl("https://user:secret@api.hunch.trade"),
    /must not contain credentials/,
  );
});

test("locks requests to the configured content API origin", () => {
  const baseUrl = validateBaseUrl("https://api.hunch.trade");
  assert.equal(
    resolveContentUrl(baseUrl, "/admin/content/articles?limit=10").toString(),
    "https://api.hunch.trade/admin/content/articles?limit=10",
  );
  assert.throws(() =>
    resolveContentUrl(baseUrl, "//evil.example/admin/content/articles"),
  );
  assert.throws(() => resolveContentUrl(baseUrl, "/health"), /Path must start/);
  assert.throws(
    () => resolveContentUrl(baseUrl, "/admin/content/../service-principals"),
    /escaped/,
  );
});

test("requires explicit confirmation for sensitive mutations", () => {
  assert.equal(
    requiredConfirmation("POST", "/admin/content/articles/abc/publish"),
    "--confirm-publish",
  );
  assert.equal(
    requiredConfirmation("POST", "/admin/content/articles/abc/approve"),
    "--confirm-publish",
  );
  assert.equal(
    requiredConfirmation(
      "POST",
      "/admin/content/articles/abc/versions/123e4567-e89b-12d3-a456-426614174000/restore",
    ),
    "--confirm-restore",
  );
  assert.equal(
    requiredConfirmation("DELETE", "/admin/content/assets/abc"),
    "--confirm-delete",
  );
  assert.equal(
    requiredConfirmation("PATCH", "/admin/content/articles/abc"),
    null,
  );
});

test("parses positional values, valued options, and confirmation flags", () => {
  const parsed = parseArgs([
    "--",
    "request",
    "/admin/content/articles/id/publish",
    "--method",
    "POST",
    "--body",
    "payload.json",
    "--confirm-publish",
  ]);
  assert.deepEqual(parsed.positional, [
    "request",
    "/admin/content/articles/id/publish",
  ]);
  assert.equal(parsed.options.get("--method"), "POST");
  assert.equal(parsed.options.get("--body"), "payload.json");
  assert.equal(parsed.options.get("--confirm-publish"), true);
});

test("accepts stdin as a JSON source and rejects unknown options", () => {
  const parsed = parseArgs([
    "request",
    "/admin/content/articles/id",
    "--method",
    "PATCH",
    "--body",
    "-",
  ]);
  assert.equal(parsed.options.get("--body"), "-");
  assert.throws(
    () => parseArgs(["operations", "--methd", "GET"]),
    /Unknown option: --methd/,
  );
});

test("accepts strict JSON session envelopes", () => {
  assert.deepEqual(
    parseSessionEnvelope(
      JSON.stringify({
        id: "read-1",
        argv: ["request", "/admin/content/articles?limit=1"],
      }),
    ),
    {
      id: "read-1",
      argv: ["request", "/admin/content/articles?limit=1"],
    },
  );
  assert.throws(
    () =>
      parseSessionEnvelope(
        JSON.stringify({ id: "unsafe", argv: ["operations"], token: "x" }),
      ),
    /only accepts id and argv/,
  );
  assert.throws(
    () => parseSessionEnvelope(JSON.stringify({ id: "missing-argv" })),
    /argv must be a non-empty string array/,
  );
});

test("restricts response exports to temporary storage", () => {
  assert.equal(
    validateOutputPath("/tmp/hunch-content-article.json"),
    "/tmp/hunch-content-article.json",
  );
  assert.throws(
    () => validateOutputPath("./article.json"),
    /restricted to \/tmp/,
  );
});

test("reserves output before a request and refuses an existing target", () => {
  const directory = fs.mkdtempSync("/tmp/hunch-content-output-");
  const outputPath = path.join(directory, "response.json");
  try {
    assert.equal(reserveJsonOutput(outputPath), outputPath);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.throws(
      () => reserveJsonOutput(outputPath),
      /refuses to overwrite an existing file/,
    );
    releaseJsonOutput(outputPath);
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("infers common content asset types", () => {
  assert.equal(inferMimeType("screenshot.PNG"), "image/png");
  assert.equal(inferMimeType("unknown.bin"), null);
  assert.equal(inferAssetKind("image/png"), "image");
  assert.equal(inferAssetKind("application/pdf"), "file");
});

test("sanitizes API error payloads", () => {
  assert.deepEqual(
    safeApiErrorPayload({
      error: "content_revision_conflict",
      message: "Article changed",
      issues: ["revision"],
      internal: "must not pass through",
      authorization: "must not pass through",
    }),
    {
      error: "content_revision_conflict",
      message: "Article changed",
      issues: ["revision"],
    },
  );
  assert.equal(safeApiErrorPayload("not-json"), null);
});
