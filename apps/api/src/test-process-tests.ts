import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import {
  configureContentServiceRuntime,
  getContentServiceRuntime,
  resetContentServiceRuntimeForTests,
} from "./content-service-runtime.js";
import { runIsolatedTestFile } from "./test-process.js";

const extension = new URL(import.meta.url).pathname.endsWith(".ts")
  ? "ts"
  : "js";
const fixture = (mode: string) =>
  new URL(`./test-process-fixture.${extension}?mode=${mode}`, import.meta.url);
const originalSend = S3Client.prototype.send;
const originalSentinel = process.env.HUNCH_TEST_PROCESS_SENTINEL;
let originalRuntime: ReturnType<typeof getContentServiceRuntime> | undefined;
try {
  originalRuntime = getContentServiceRuntime();
} catch {
  // A standalone run has no configured content runtime yet.
}
try {
  const parent = resolveContentRuntimeConfig(
    {
      CONTENT_ASSET_S3_BUCKET: "parent",
      CONTENT_ASSET_PUBLIC_BASE_URL: "https://parent.example.test",
    },
    "test",
  );
  process.env.HUNCH_TEST_PROCESS_SENTINEL = "parent";
  configureContentServiceRuntime(parent);
  runIsolatedTestFile(fixture("mutation"));
  assert.equal(S3Client.prototype.send, originalSend);
  assert.equal(getContentServiceRuntime(), parent);
  assert.equal(process.env.HUNCH_TEST_PROCESS_SENTINEL, "parent");
  for (const mode of ["assertion", "async", "cleanup"])
    assert.throws(
      () => runIsolatedTestFile(fixture(mode), { quiet: true }),
      /status=1/,
    );
  assert.throws(
    () => runIsolatedTestFile(fixture("signal"), { quiet: true }),
    /signal=SIGKILL/,
  );
  assert.throws(
    () =>
      runIsolatedTestFile(fixture("timeout"), { timeoutMs: 100, quiet: true }),
    /ETIMEDOUT/,
  );
  // A failed or killed fixture cannot poison the next test process either.
  runIsolatedTestFile(fixture("mutation"));
  assert.equal(S3Client.prototype.send, originalSend);
  assert.equal(getContentServiceRuntime(), parent);
  console.log(
    "[test-process-tests] isolation, async failures, cleanup, signals, timeout and recovery passed",
  );
} finally {
  if (originalRuntime) configureContentServiceRuntime(originalRuntime);
  else resetContentServiceRuntimeForTests();
  if (originalSentinel === undefined)
    delete process.env.HUNCH_TEST_PROCESS_SENTINEL;
  else process.env.HUNCH_TEST_PROCESS_SENTINEL = originalSentinel;
}
