import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { env } from "../env.js";
import {
  generateJournalServiceToken,
  JOURNAL_SERVICE_SCOPES,
  type JournalServiceScope,
} from "./journal-service-auth.js";

function assertScopes(scopes: string[]): JournalServiceScope[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))].sort();
  if (normalized.length === 0)
    throw new Error("At least one scope is required");
  for (const scope of normalized) {
    if (!JOURNAL_SERVICE_SCOPES.includes(scope as JournalServiceScope)) {
      throw new Error(`Unsupported service scope: ${scope}`);
    }
  }
  return normalized as JournalServiceScope[];
}

function assertNote(note: string): string {
  const normalized = note.trim();
  if (!normalized || normalized.length > 500) {
    throw new Error("Operator note must be between 1 and 500 characters");
  }
  return normalized;
}

async function tx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
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

function assertCredentialTtl(ttlDays: number): void {
  if (
    !Number.isInteger(ttlDays) ||
    ttlDays < 1 ||
    ttlDays > env.journalServiceCredentialMaxTtlDays
  ) {
    throw new Error(
      `Credential TTL must be between 1 and ${env.journalServiceCredentialMaxTtlDays} days`,
    );
  }
}

async function lockActivePrincipal(client: PoolClient, principalId: string) {
  const principal = await client.query<{
    id: string;
    status: "active" | "disabled";
  }>(
    `select id, status from admin_service_principals where id = $1 for update`,
    [principalId],
  );
  const row = principal.rows[0];
  if (!row) throw new Error("Service principal not found");
  if (row.status !== "active") throw new Error("Service principal is disabled");
  return row;
}

async function assertCredentialCapacity(
  client: PoolClient,
  principalId: string,
): Promise<void> {
  const active = await client.query<{ count: string }>(
    `
      select count(*)::text as count
      from admin_service_credentials
      where service_principal_id = $1
        and revoked_at is null
        and expires_at > now()
    `,
    [principalId],
  );
  if (Number(active.rows[0]?.count ?? 0) >= 2) {
    throw new Error("Service principal already has two active credentials");
  }
}

async function insertJournalServiceCredential(
  client: PoolClient,
  input: {
    principalId: string;
    scopes: JournalServiceScope[];
    ttlDays: number;
    actorAdminId: string;
    note: string;
  },
) {
  const credentialId = randomUUID();
  const generated = generateJournalServiceToken(credentialId);
  const { rows } = await client.query<{
    id: string;
    expires_at: Date | string;
    created_at: Date | string;
  }>(
    `
      insert into admin_service_credentials (
        id, service_principal_id, token_hmac, token_prefix, token_last_four,
        scopes, expires_at, created_by_admin_id, created_note
      ) values (
        $1, $2, $3, $4, $5, $6::text[],
        now() + ($7::text || ' days')::interval, $8, $9
      )
      returning id, expires_at, created_at
    `,
    [
      credentialId,
      input.principalId,
      generated.tokenHmac,
      generated.tokenPrefix,
      generated.tokenLastFour,
      input.scopes,
      input.ttlDays,
      input.actorAdminId,
      input.note,
    ],
  );
  const credential = rows[0];
  return {
    id: credential.id,
    principalId: input.principalId,
    token: generated.token,
    tokenPrefix: generated.tokenPrefix,
    tokenLastFour: generated.tokenLastFour,
    scopes: input.scopes,
    expiresAt: new Date(credential.expires_at).toISOString(),
    createdAt: new Date(credential.created_at).toISOString(),
  };
}

export async function createJournalServicePrincipal(
  pool: Pool,
  input: {
    key: string;
    displayName: string;
    actorAdminId: string;
    note: string;
  },
) {
  const note = assertNote(input.note);
  const { rows } = await pool.query<{
    id: string;
    key: string;
    display_name: string;
    status: "active";
    created_at: Date | string;
  }>(
    `
      insert into admin_service_principals (
        key, display_name, created_by_admin_id, metadata
      ) values ($1, $2, $3, jsonb_build_object('createdNote', $4::text))
      returning id, key, display_name, status, created_at
    `,
    [input.key.trim(), input.displayName.trim(), input.actorAdminId, note],
  );
  return rows[0];
}

export async function issueJournalServiceCredential(
  pool: Pool,
  input: {
    principalId: string;
    scopes: string[];
    ttlDays: number;
    actorAdminId: string;
    note: string;
  },
) {
  const scopes = assertScopes(input.scopes);
  const note = assertNote(input.note);
  assertCredentialTtl(input.ttlDays);

  return tx(pool, async (client) => {
    const principal = await lockActivePrincipal(client, input.principalId);
    await assertCredentialCapacity(client, principal.id);
    return insertJournalServiceCredential(client, {
      principalId: principal.id,
      scopes,
      ttlDays: input.ttlDays,
      actorAdminId: input.actorAdminId,
      note,
    });
  });
}

export async function rotateJournalServiceCredential(
  pool: Pool,
  input: {
    credentialId: string;
    scopes: string[];
    ttlDays: number;
    actorAdminId: string;
    note: string;
  },
) {
  const scopes = assertScopes(input.scopes);
  const note = assertNote(input.note);
  assertCredentialTtl(input.ttlDays);

  return tx(pool, async (client) => {
    const lookup = await client.query<{ service_principal_id: string }>(
      `select service_principal_id from admin_service_credentials where id = $1`,
      [input.credentialId],
    );
    const principalId = lookup.rows[0]?.service_principal_id;
    if (!principalId) throw new Error("Service credential not found");
    await lockActivePrincipal(client, principalId);

    const existing = await client.query<{ revoked_at: Date | string | null }>(
      `
        select revoked_at
        from admin_service_credentials
        where id = $1 and service_principal_id = $2
        for update
      `,
      [input.credentialId, principalId],
    );
    if (!existing.rows[0]) throw new Error("Service credential not found");
    if (existing.rows[0].revoked_at) {
      throw new Error("Service credential has already been revoked");
    }

    await client.query(
      `
        update admin_service_credentials
        set revoked_at = now(), revoked_by_admin_id = $2, revoked_reason = $3
        where id = $1
      `,
      [input.credentialId, input.actorAdminId, note],
    );
    await assertCredentialCapacity(client, principalId);
    const issued = await insertJournalServiceCredential(client, {
      principalId,
      scopes,
      ttlDays: input.ttlDays,
      actorAdminId: input.actorAdminId,
      note,
    });
    return { ...issued, rotatedCredentialId: input.credentialId };
  });
}

export async function revokeJournalServiceCredential(
  pool: Pool,
  input: { credentialId: string; actorAdminId: string; reason: string },
) {
  const reason = assertNote(input.reason);
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

export async function disableJournalServicePrincipal(
  pool: Pool,
  input: { principalId: string; actorAdminId: string; reason: string },
) {
  const reason = assertNote(input.reason);
  return tx(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `
        update admin_service_principals
        set status = 'disabled', disabled_at = coalesce(disabled_at, now()),
            disabled_by_admin_id = coalesce(disabled_by_admin_id, $2),
            metadata = case
              when disabled_at is null
                then metadata || jsonb_build_object('disabledNote', $3::text)
              else metadata
            end
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

export async function listJournalServicePrincipals(pool: Pool) {
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
              'scopes', credential.scopes,
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
