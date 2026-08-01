import type { ContentRuntimeConfig } from "@hunch/config/content";

let runtimeConfig: ContentRuntimeConfig | null = null;

export function configureContentServiceRuntime(
  config: ContentRuntimeConfig,
): void {
  runtimeConfig = config;
}

export function getContentServiceRuntime(): ContentRuntimeConfig {
  if (!runtimeConfig) {
    throw new Error("Content service runtime is not configured");
  }
  return runtimeConfig;
}

export function resetContentServiceRuntimeForTests(): void {
  runtimeConfig = null;
}
