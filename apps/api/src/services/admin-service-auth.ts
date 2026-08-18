import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "@hunch/infra";

import { env } from "../env.js";
import type { AdminPermission } from "./admin-auth.js";

export const ADMIN_SERVICE_PERMISSIONS = [
  "content:read",
  "content:write",
  "content:publish",
] as const satisfies readonly AdminPermission[];

export type AdminServicePermission = (typeof ADMIN_SERVICE_PERMISSIONS)[number];

export type AdminServicePrincipal = {
  id: string;
  key: string;
  displayName: string;
};

export type AdminServiceCredential = {
  id: string;
  prefix: string;
  permissions: AdminServicePermission[];
  expiresAt: string;
};

type CredentialRow = {
  credential_id: string;
  service_principal_id: string;
  token_hmac: string;
  token_prefix: string;
  permissions: string[];
  expires_at: Date | string;
  revoked_at: Date | string | null;
  principal_key: string;
  principal_display_name: string;
  principal_status: "active" | "disabled";
};

const TOKEN_PATTERN =
  /^hsa_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

function pepper(value = env.adminServiceTokenPepper): string {
  if (value.length < 32) {
    throw new Error("Admin service token pepper is not configured");
  }
  return value;
}

export function isAdminServiceToken(token: string): boolean {
  return token.startsWith("hsa_v1.");
}

export function adminServiceHasPermissions(
  granted: readonly AdminServicePermission[],
  required: readonly AdminPermission[],
): boolean {
  const permissions = new Set<string>(granted);
  return required.every((permission) => permissions.has(permission));
}

export function adminServiceTokenHmac(
  token: string,
  tokenPepper?: string,
): string {
  return createHmac("sha256", pepper(tokenPepper))
    .update(token, "utf8")
    .digest("hex");
}

export function generateAdminServiceToken(credentialId: string): {
  token: string;
  tokenHmac: string;
  tokenPrefix: string;
  tokenLastFour: string;
} {
  const token = `hsa_v1.${credentialId}.${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHmac: adminServiceTokenHmac(token),
    tokenPrefix: token.slice(0, 16),
    tokenLastFour: token.slice(-4),
  };
}

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function authenticateAdminServiceCredential(
  pool: Pool,
  token: string,
  options: { pepper?: string; nowMs?: number } = {},
): Promise<
  | {
      ok: true;
      principal: AdminServicePrincipal;
      credential: AdminServiceCredential;
    }
  | {
      ok: false;
      statusCode: 401 | 503;
      error: string;
      message: string;
    }
> {
  const credentialId = TOKEN_PATTERN.exec(token)?.[1];
  if (!credentialId) {
    return {
      ok: false,
      statusCode: 401,
      error: "invalid_admin_service_credential",
      message: "Invalid admin API key",
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
          credential.permissions,
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
    console.error("[admin-service-auth] credential lookup failed", {
      credentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      statusCode: 503,
      error: "admin_service_auth_unavailable",
      message: "Admin API key authentication is temporarily unavailable",
    };
  }

  let candidateHmac: string;
  try {
    candidateHmac = adminServiceTokenHmac(token, options.pepper);
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error: "admin_service_auth_unavailable",
      message: "Admin API key authentication is not configured",
    };
  }
  if (!row || !equalHash(candidateHmac, row.token_hmac)) {
    return {
      ok: false,
      statusCode: 401,
      error: "invalid_admin_service_credential",
      message: "Invalid admin API key",
    };
  }
  if (row.revoked_at) {
    return {
      ok: false,
      statusCode: 401,
      error: "revoked_admin_service_credential",
      message: "Admin API key has been revoked",
    };
  }
  if (new Date(row.expires_at).getTime() <= (options.nowMs ?? Date.now())) {
    return {
      ok: false,
      statusCode: 401,
      error: "expired_admin_service_credential",
      message: "Admin API key has expired",
    };
  }
  if (row.principal_status !== "active") {
    return {
      ok: false,
      statusCode: 401,
      error: "disabled_admin_service_principal",
      message: "Admin service principal is disabled",
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
      console.warn("[admin-service-auth] last_used_at update failed", {
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
      permissions: row.permissions.filter(
        (permission): permission is AdminServicePermission =>
          ADMIN_SERVICE_PERMISSIONS.includes(
            permission as AdminServicePermission,
          ),
      ),
      expiresAt: new Date(row.expires_at).toISOString(),
    },
  };
}
