import { closeAcquiredRuntimeResources } from "./runtime-resource-cleanup.js";

const file = new URL(process.argv[2]);
if (file.protocol !== "file:") throw new Error("Expected a local test module");
try {
  // Inherit the runner's already-verified DB target and secret-bootstrap marker.
  // Each mutating integration fixture still verifies current_database() itself.
  await import(file.href);
} finally {
  await closeAcquiredRuntimeResources();
}
