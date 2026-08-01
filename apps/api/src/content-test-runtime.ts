import { resolveContentRuntimeConfig } from "@hunch/config/content";

import { configureContentServiceRuntime } from "./content-service-runtime.js";

export function configureContentTestRuntime(
  source: NodeJS.ProcessEnv = process.env,
): void {
  configureContentServiceRuntime(
    resolveContentRuntimeConfig(
      {
        ...source,
        CONTENT_ENABLED: source.CONTENT_ENABLED ?? "true",
        CONTENT_WORKER_ENABLED: source.CONTENT_WORKER_ENABLED ?? "true",
      },
      "test",
    ),
  );
}
