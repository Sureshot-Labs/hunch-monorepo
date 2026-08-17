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
  if (!/^hjs_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(serviceToken)) {
    throw new Error("JOURNAL_SERVICE_TOKEN has an invalid format");
  }
  return {
    apiOrigin: parseOrigin(required("JOURNAL_SERVICE_API_ORIGIN", env)),
    serviceToken,
    allowedRoots: parseAllowedRoots(required("JOURNAL_MCP_ALLOWED_ROOTS", env)),
    enableReviewSubmit: env.JOURNAL_MCP_ENABLE_REVIEW_SUBMIT === "true",
  };
}
