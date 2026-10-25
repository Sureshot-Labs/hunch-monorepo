import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { resolveContentRuntimeConfig } from "@hunch/config/content";
import { configureContentServiceRuntime } from "./content-service-runtime.js";
import { registerRuntimeResourceCleanup } from "./runtime-resource-cleanup.js";

// Bun removes the import query from import.meta.url; the entry argument retains it.
const mode = new URL(process.argv[2]).searchParams.get("mode");
if (mode === "signal") process.kill(process.pid, "SIGKILL");
if (mode === "timeout") await new Promise(() => setInterval(() => {}, 1000));
if (mode === "assertion") assert.fail("isolated synchronous failure");
if (mode === "async") {
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.fail("isolated asynchronous failure");
}
if (mode === "cleanup") {
  registerRuntimeResourceCleanup("fixture", async () => {
    throw new Error("isolated cleanup failure");
  });
} else {
  assert.equal(mode, "mutation");
  assert.equal(process.env.HUNCH_TEST_PROCESS_SENTINEL, "parent");
  process.env.HUNCH_TEST_PROCESS_SENTINEL = "child";
  S3Client.prototype.send = (() => {
    throw new Error("child SDK mock must not escape");
  }) as typeof S3Client.prototype.send;
  configureContentServiceRuntime(
    resolveContentRuntimeConfig(
      {
        CONTENT_ASSET_S3_BUCKET: "child",
        CONTENT_ASSET_PUBLIC_BASE_URL: "https://child.example.test",
      },
      "test",
    ),
  );
}
