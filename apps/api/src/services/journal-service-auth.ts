import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import { checkRateLimitStatus } from "../lib/rate-limit.js";
import {
  checkRateLimitForSecurityClientIpStatus,
  resolveSecurityClientIp,
} from "../lib/request-ip.js";
import { serviceContentActor } from "./content-actor.js";
import { recordJournalServiceAuth } from "./journal-service-observability.js";

export const JOURNAL_SERVICE_SCOPES = [
  "journal:read",
  "journal:draft:create",
  "journal:draft:update",
  "journal:draft:checkpoint",
  "journal:asset:upload-image",
  "journal:validate",
  "journal:preview:create",
  "journal:review:submit",
] as const;

export type JournalServiceScope = (typeof JOURNAL_SERVICE_SCOPES)[number];

export type JournalServicePrincipal = {
  id: string;
  key: string;
  displayName: string;
};

export type JournalServiceCredential = {
  id: string;
  prefix: string;
  scopes: JournalServiceScope[];
  expiresAt: string;
};

type CredentialRow = {
  credential_id: string;
  service_principal_id: string;
  token_hmac: string;
  token_prefix: string;
  scopes: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
  principal_key: string;
  principal_display_name: string;
  principal_status: "active" | "disabled";
};

type RateProfile = "read" | "mutation" | "upload";

const TOKEN_PATTERN =
  /^hjs_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function requiredPepper(): string {
  const pepper = env.journalServiceTokenPepper;
  if (pepper.length < 32) {
    throw new Error("Journal service token pepper is not configured");
  }
  return pepper;
}

export function journalServiceTokenHmac(
  token: string,
  pepper = requiredPepper(),
): string {
  return createHmac("sha256", pepper).update(token, "utf8").digest("hex");
}

export function generateJournalServiceToken(credentialId: string): {
  token: string;
  tokenHmac: string;
  tokenPrefix: string;
  tokenLastFour: string;
} {
  const secret = randomBytes(32).toString("base64url");
  const token = `hjs_v1.${credentialId}.${secret}`;
  return {
    token,
    tokenHmac: journalServiceTokenHmac(token),
    tokenPrefix: token.slice(0, 16),
    tokenLastFour: token.slice(-4),
  };
}

function parseCredentialId(token: string): string | null {
  return TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function bearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

function rateLimitFor(profile: RateProfile): number {
  if (profile === "upload") return env.journalServiceUploadRatePerMinute;
  if (profile === "mutation") return env.journalServiceMutationRatePerMinute;
  return env.journalServiceReadRatePerMinute;
}

export async function authenticateJournalServiceCredential(
  pool: Pool,
  token: string,
  options: { pepper?: string; nowMs?: number } = {},
): Promise<
  | {
      ok: true;
      principal: JournalServicePrincipal;
      credential: JournalServiceCredential;
    }
  | {
      ok: false;
      statusCode: 401 | 503;
      error: string;
      message: string;
    }
> {
  const credentialId = parseCredentialId(token);
  if (!credentialId) {
    return {
      ok: false,
      statusCode: 401,
      error: "invalid_service_credential",
      message: "Invalid service credential",
    };
  }

  let row: CredentialRow | undefined;
  try {
    const result = await pool.query<CredentialRow>(
      `
        select
          credential.id as credential_id,
          credential.service_principal_id,
          credential.token_hmac,
          credential.token_prefix,
          credential.scopes,
          credential.expires_at,
          credential.revoked_at,
          principal.key as principal_key,
          principal.display_name as principal_display_name,
          principal.status as principal_status
        from admin_service_credentials credential
        join admin_service_principals principal
          on principal.id = credential.service_principal_id
        where credential.id = $1
        limit 1
      `,
      [credentialId],
    );
    row = result.rows[0];
  } catch (error) {
    console.error("[journal-service-auth] credential lookup failed", {
      credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      statusCode: 503,
      error: "service_auth_unavailable",
      message: "Service authentication is temporarily unavailable",
    };
  }

  const candidateHmac = journalServiceTokenHmac(token, options.pepper);
  const storedHmac = row?.token_hmac ?? "0".repeat(64);
  const hmacMatches = equalHex(candidateHmac, storedHmac);
  if (!row || !hmacMatches) {
    return {
      ok: false,
      statusCode: 401,
      error: "invalid_service_credential",
      message: "Invalid service credential",
    };
  }
  if (row.revoked_at) {
    return {
      ok: false,
      statusCode: 401,
      error: "revoked_service_credential",
      message: "Service credential has been revoked",
    };
  }
  if (new Date(row.expires_at).getTime() <= (options.nowMs ?? Date.now())) {
    return {
      ok: false,
      statusCode: 401,
      error: "expired_service_credential",
      message: "Service credential has expired",
    };
  }
  if (row.principal_status !== "active") {
    return {
      ok: false,
      statusCode: 401,
      error: "disabled_service_principal",
      message: "Service principal is disabled",
    };
  }

  void pool
    .query(
      `
        update admin_service_credentials
        set last_used_at = now()
        where id = $1
          and (last_used_at is null or last_used_at < now() - interval '5 minutes')
      `,
      [row.credential_id],
    )
    .catch((error: unknown) => {
      console.warn("[journal-service-auth] last_used_at update failed", {
        credentialId: row?.credential_id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return {
    ok: true,
    principal: {
      id: row.service_principal_id,
      key: row.principal_key,
      displayName: row.principal_display_name,
    },
    credential: {
      id: row.credential_id,
      prefix: row.token_prefix,
      scopes: row.scopes.filter((scope): scope is JournalServiceScope =>
        JOURNAL_SERVICE_SCOPES.includes(scope as JournalServiceScope),
      ),
      expiresAt: new Date(row.expires_at).toISOString(),
    },
  };
}

export function createJournalServiceMiddleware(
  pool: Pool,
  options: {
    requiredScope: JournalServiceScope;
    rateProfile: RateProfile;
  },
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    request.journalServiceRequiredScope = options.requiredScope;
    if (!env.journalServiceApiEnabled) {
      recordJournalServiceAuth("feature_disabled");
      return reply.code(404).send({ error: "not_found" });
    }

    const maxRequests = rateLimitFor(options.rateProfile);
    const ipLimit = await checkRateLimitForSecurityClientIpStatus(request, {
      keyPrefix: `journal-service:${options.rateProfile}:ip`,
      maxRequests,
      windowMs: 60_000,
    });
    if (ipLimit.status === "unavailable") {
      recordJournalServiceAuth("security_backend_unavailable");
      return reply
        .code(503)
        .send({ error: "service_security_backend_unavailable" });
    }
    if (ipLimit.status === "limited") {
      recordJournalServiceAuth("ip_rate_limited");
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "service_rate_limit_exceeded" });
    }

    const token = bearerToken(request);
    if (!token) {
      recordJournalServiceAuth("missing_credential");
      return reply.code(401).send({
        error: "invalid_service_credential",
        message: "Service bearer credential required",
      });
    }
    const result = await authenticateJournalServiceCredential(pool, token);
    if (!result.ok) {
      recordJournalServiceAuth(result.error);
      return reply.code(result.statusCode).send({
        error: result.error,
        message: result.message,
      });
    }

    const principalLimit = await checkRateLimitStatus(
      `journal-service:${options.rateProfile}:principal:${result.principal.id}`,
      maxRequests,
      60_000,
    );
    if (principalLimit === "unavailable") {
      recordJournalServiceAuth("security_backend_unavailable");
      return reply
        .code(503)
        .send({ error: "service_security_backend_unavailable" });
    }
    if (principalLimit === "limited") {
      recordJournalServiceAuth("principal_rate_limited");
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "service_rate_limit_exceeded" });
    }
    if (!result.credential.scopes.includes(options.requiredScope)) {
      recordJournalServiceAuth("scope_required");
      return reply.code(403).send({
        error: "service_scope_required",
        message: `Required scope: ${options.requiredScope}`,
      });
    }

    request.journalServicePrincipal = result.principal;
    request.journalServiceCredential = result.credential;
    request.contentActor = serviceContentActor(
      result.principal.id,
      result.principal.displayName,
    );
    request.journalServiceClientIp = resolveSecurityClientIp(request);
    recordJournalServiceAuth("success");
  };
}
