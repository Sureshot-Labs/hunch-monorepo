import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { env } from "../env.js";
import {
  ADMIN_SERVICE_PERMISSIONS,
  generateAdminServiceToken,
  type AdminServicePermission,
} from "./admin-service-auth.js";

function requiredText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${name} must be between 1 and ${max} characters`);
  }
  return normalized;
}

function permissions(values: string[]): AdminServicePermission[] {
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  if (!normalized.length)
    throw new Error("At least one permission is required");
  for (const permission of normalized) {
    if (
      !ADMIN_SERVICE_PERMISSIONS.includes(permission as AdminServicePermission)
    ) {
      throw new Error(`Unsupported admin service permission: ${permission}`);
    }
  }
  return normalized as AdminServicePermission[];
}

function ttlDays(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > env.adminServiceCredentialMaxTtlDays
  ) {
    throw new Error(
      `Credential TTL must be between 1 and ${env.adminServiceCredentialMaxTtlDays} days`,
    );
  }
  return value;
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createAdminServicePrincipal(
  pool: Pool,
  input: {
    key: string;
    displayName: string;
    actorAdminId: string;
    note: string;
  },
) {
  const key = input.key.trim();
  if (
    key.length < 3 ||
    key.length > 80 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)
  ) {
    throw new Error("Principal key must be lowercase kebab-case");
  }
  const displayName = requiredText(input.displayName, "Display name", 160);
  const note = requiredText(input.note, "Operator note", 500);
  const { rows } = await pool.query<{
    id: string;
    key: string;
    displayName: string;
    status: "active";
    createdAt: Date | string;
  }>(
    `
      insert into admin_service_principals (
        key, display_name, created_by_admin_id, metadata
      ) values ($1, $2, $3, jsonb_build_object('createdNote', $4::text))
      returning id, key, display_name as "displayName", status,
        created_at as "createdAt"
    `,
    [key, displayName, input.actorAdminId, note],
  );
  return rows[0];
}

export async function issueAdminServiceCredential(
  pool: Pool,
  input: {
    principalId: string;
    permissions: string[];
    ttlDays: number;
    actorAdminId: string;
    note: string;
  },
) {
  const allowed = permissions(input.permissions);
  const lifetime = ttlDays(input.ttlDays);
  const note = requiredText(input.note, "Operator note", 500);
  return transaction(pool, async (client) => {
    const principal = await client.query<{
      id: string;
      status: "active" | "disabled";
    }>(
      `select id, status from admin_service_principals where id = $1 for update`,
      [input.principalId],
    );
    if (!principal.rows[0]) throw new Error("Service principal not found");
    if (principal.rows[0].status !== "active") {
      throw new Error("Service principal is disabled");
    }
    const active = await client.query<{ count: string }>(
      `
        select count(*)::text as count
        from admin_service_credentials
        where service_principal_id = $1
          and revoked_at is null
          and expires_at > now()
      `,
      [input.principalId],
    );
    if (Number(active.rows[0]?.count ?? 0) >= 2) {
      throw new Error("Service principal already has two active API keys");
    }

    const credentialId = randomUUID();
    const generated = generateAdminServiceToken(credentialId);
    const { rows } = await client.query<{
      expires_at: Date | string;
      created_at: Date | string;
    }>(
      `
        insert into admin_service_credentials (
          id, service_principal_id, token_hmac, token_prefix, token_last_four,
          permissions, expires_at, created_by_admin_id, created_note
        ) values (
          $1, $2, $3, $4, $5, $6::text[],
          now() + ($7::text || ' days')::interval, $8, $9
        )
        returning expires_at, created_at
      `,
      [
        credentialId,
        input.principalId,
        generated.tokenHmac,
        generated.tokenPrefix,
        generated.tokenLastFour,
        allowed,
        lifetime,
        input.actorAdminId,
        note,
      ],
    );
    return {
      id: credentialId,
      principalId: input.principalId,
      token: generated.token,
      tokenPrefix: generated.tokenPrefix,
      tokenLastFour: generated.tokenLastFour,
      permissions: allowed,
      expiresAt: new Date(rows[0].expires_at).toISOString(),
      createdAt: new Date(rows[0].created_at).toISOString(),
    };
  });
}

export async function revokeAdminServiceCredential(
  pool: Pool,
  input: { credentialId: string; actorAdminId: string; reason: string },
) {
  const reason = requiredText(input.reason, "Revocation reason", 500);
  const { rows } = await pool.query<{ id: string }>(
    `
      update admin_service_credentials
      set revoked_at = coalesce(revoked_at, now()),
          revoked_by_admin_id = coalesce(revoked_by_admin_id, $2),
          revoked_reason = coalesce(revoked_reason, $3)
      where id = $1
      returning id
    `,
    [input.credentialId, input.actorAdminId, reason],
  );
  if (!rows[0]) throw new Error("Service credential not found");
  return rows[0];
}

export async function disableAdminServicePrincipal(
  pool: Pool,
  input: { principalId: string; actorAdminId: string; reason: string },
) {
  const reason = requiredText(input.reason, "Disable reason", 500);
  return transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `
        update admin_service_principals
        set status = 'disabled', disabled_at = coalesce(disabled_at, now()),
            disabled_by_admin_id = coalesce(disabled_by_admin_id, $2),
            metadata = case when disabled_at is null
              then metadata || jsonb_build_object('disabledNote', $3::text)
              else metadata end
        where id = $1
        returning id
      `,
      [input.principalId, input.actorAdminId, reason],
    );
    if (!rows[0]) throw new Error("Service principal not found");
    await client.query(
      `
        update admin_service_credentials
        set revoked_at = coalesce(revoked_at, now()),
            revoked_by_admin_id = coalesce(revoked_by_admin_id, $2),
            revoked_reason = coalesce(revoked_reason, 'principal disabled')
        where service_principal_id = $1 and revoked_at is null
      `,
      [input.principalId, input.actorAdminId],
    );
    return rows[0];
  });
}

export async function listAdminServicePrincipals(pool: Pool) {
  const { rows } = await pool.query(
    `
      select
        principal.id,
        principal.key,
        principal.display_name as "displayName",
        principal.status,
        principal.created_at as "createdAt",
        principal.disabled_at as "disabledAt",
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', credential.id,
              'prefix', credential.token_prefix,
              'lastFour', credential.token_last_four,
              'permissions', credential.permissions,
              'expiresAt', credential.expires_at,
              'revokedAt', credential.revoked_at,
              'lastUsedAt', credential.last_used_at
            ) order by credential.created_at desc
          ) filter (where credential.id is not null),
          '[]'::jsonb
        ) as credentials
      from admin_service_principals principal
      left join admin_service_credentials credential
        on credential.service_principal_id = principal.id
      group by principal.id
      order by principal.created_at desc, principal.id desc
    `,
  );
  return rows;
}
