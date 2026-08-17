import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type AllowedRoot = {
  configuredPath: string;
  realPath: string;
};

export type JournalMcpConfig = {
  apiOrigin: URL;
  serviceToken: string;
  allowedRoots: AllowedRoot[];
  enableReviewSubmit: boolean;
};

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalBoolean(name: string, env: NodeJS.ProcessEnv): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function parseOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("JOURNAL_SERVICE_API_ORIGIN must not contain credentials");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(
      "JOURNAL_SERVICE_API_ORIGIN must be an origin without a path",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLocalhost(url.hostname))
  ) {
    throw new Error(
      "JOURNAL_SERVICE_API_ORIGIN must use HTTPS outside localhost",
    );
  }
  return new URL(url.origin);
}

function parseAllowedRoots(raw: string): AllowedRoot[] {
  const candidates = raw
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("JOURNAL_MCP_ALLOWED_ROOTS must contain at least one root");
  }
  return candidates.map((candidate) => {
    const configuredPath = path.resolve(candidate);
    const realPath = realpathSync(configuredPath);
    if (!statSync(realPath).isDirectory()) {
      throw new Error(
        `Allowed image root is not a directory: ${configuredPath}`,
      );
    }
    return { configuredPath, realPath };
  });
}

export function loadJournalMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): JournalMcpConfig {
  const serviceToken = required("JOURNAL_SERVICE_TOKEN", env);
  if (
    !/^hjs_v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(
      serviceToken,
    )
  ) {
    throw new Error("JOURNAL_SERVICE_TOKEN has an invalid format");
  }
  return {
    apiOrigin: parseOrigin(required("JOURNAL_SERVICE_API_ORIGIN", env)),
    serviceToken,
    allowedRoots: parseAllowedRoots(required("JOURNAL_MCP_ALLOWED_ROOTS", env)),
    enableReviewSubmit: optionalBoolean(
      "JOURNAL_MCP_ENABLE_REVIEW_SUBMIT",
      env,
    ),
  };
}
