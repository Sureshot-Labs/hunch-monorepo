import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { tx } from "@hunch/infra";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import { contentPayloadHash } from "./content-document.js";

export type JournalIdempotencyOperation =
  | "create_article"
  | "create_asset_upload";

type IdempotencyRow = {
  id: string | number | bigint;
  request_hash: string;
  state: "processing" | "completed" | "failed";
  lease_expires_at: Date | string | null;
  lease_expired?: boolean;
  lease_owner: string | null;
  resource_type: "article" | "asset" | null;
  resource_id: string | null;
  http_status: number | null;
  response: Record<string, unknown> | null;
};

export class JournalIdempotencyError extends Error {
  constructor(
    public readonly code:
      | "idempotency_key_reused"
      | "idempotency_in_progress"
      | "idempotency_result_unavailable",
    message: string,
    public readonly statusCode: 409 | 500,
  ) {
    super(message);
    this.name = "JournalIdempotencyError";
  }
}

export type JournalIdempotencyClaim = {
  rowId: string;
  leaseOwner: string | null;
  resourceId: string;
  replay: boolean;
  reclaimed: boolean;
  httpStatus: number | null;
  response: Record<string, unknown> | null;
};

export function journalIdempotencyResourceForClaim<T>(
  claim: JournalIdempotencyClaim,
  resource: T | null | undefined,
  resourceType: "article" | "asset",
): T | null {
  if (claim.replay && resource == null) {
    throw new JournalIdempotencyError(
      "idempotency_result_unavailable",
      `The ${resourceType} created by this idempotent request is no longer available`,
      409,
    );
  }
  return resource ?? null;
}

export function journalIdempotencyRequestHash(
  operation: JournalIdempotencyOperation,
  body: unknown,
): string {
  return contentPayloadHash({ operation, body });
}

export type JournalIdempotencyClaimInput = {
  principalId: string;
  operation: JournalIdempotencyOperation;
  idempotencyKey: string;
  requestHash: string;
  resourceType: "article" | "asset";
  proposedResourceId?: string;
};

export async function claimJournalIdempotency(
  pool: Pool,
  input: JournalIdempotencyClaimInput,
): Promise<JournalIdempotencyClaim> {
  return tx(pool, (db) => claimJournalIdempotencyInTransaction(db, input));
}

export async function claimJournalIdempotencyInTransaction(
  db: DbQuery,
  input: JournalIdempotencyClaimInput,
): Promise<JournalIdempotencyClaim> {
  const leaseOwner = randomUUID();
  const resourceId = input.proposedResourceId ?? randomUUID();
  await db.query(
    `
      delete from content_machine_idempotency_keys
      where service_principal_id = $1
        and operation = $2
        and idempotency_key = $3
        and expires_at <= now()
    `,
    [input.principalId, input.operation, input.idempotencyKey],
  );
  const inserted = await db.query<IdempotencyRow>(
    `
        insert into content_machine_idempotency_keys (
          service_principal_id, operation, idempotency_key, request_hash,
          state, lease_expires_at, lease_owner, resource_type, resource_id
        ) values (
          $1, $2, $3, $4, 'processing',
          now() + ($5::text || ' seconds')::interval, $6, $7, $8
        )
        on conflict (service_principal_id, operation, idempotency_key)
        do nothing
        returning id, request_hash, state, lease_expires_at, lease_owner,
                  resource_type, resource_id, http_status, response
      `,
    [
      input.principalId,
      input.operation,
      input.idempotencyKey,
      input.requestHash,
      env.journalServiceIdempotencyLeaseSec,
      leaseOwner,
      input.resourceType,
      resourceId,
    ],
  );
  const created = inserted.rows[0];
  if (created) {
    return {
      rowId: String(created.id),
      leaseOwner,
      resourceId: created.resource_id ?? resourceId,
      replay: false,
      reclaimed: false,
      httpStatus: null,
      response: null,
    };
  }

  const existingResult = await db.query<IdempotencyRow>(
    `
        select id, request_hash, state, lease_expires_at, lease_owner,
               (lease_expires_at <= now()) as lease_expired,
               resource_type, resource_id, http_status, response
        from content_machine_idempotency_keys
        where service_principal_id = $1
          and operation = $2
          and idempotency_key = $3
        for update
      `,
    [input.principalId, input.operation, input.idempotencyKey],
  );
  const existing = existingResult.rows[0];
  if (!existing) {
    throw new JournalIdempotencyError(
      "idempotency_result_unavailable",
      "Idempotency record disappeared during claim",
      500,
    );
  }
  if (existing.request_hash !== input.requestHash) {
    throw new JournalIdempotencyError(
      "idempotency_key_reused",
      "Idempotency key was already used with a different request",
      409,
    );
  }
  if (existing.state === "completed") {
    if (!existing.resource_id || existing.http_status == null) {
      throw new JournalIdempotencyError(
        "idempotency_result_unavailable",
        "Stored idempotency result is incomplete",
        500,
      );
    }
    return {
      rowId: String(existing.id),
      leaseOwner: null,
      resourceId: existing.resource_id,
      replay: true,
      reclaimed: false,
      httpStatus: existing.http_status,
      response: existing.response,
    };
  }
  if (existing.state === "failed") {
    throw new JournalIdempotencyError(
      "idempotency_result_unavailable",
      "Stored idempotency request failed terminally",
      500,
    );
  }

  if (!existing.lease_expired) {
    throw new JournalIdempotencyError(
      "idempotency_in_progress",
      "An identical request is already in progress",
      409,
    );
  }
  const recoveredResourceId = existing.resource_id ?? resourceId;
  await db.query(
    `
        update content_machine_idempotency_keys
        set lease_owner = $2,
            lease_expires_at = now() + ($3::text || ' seconds')::interval,
            attempt_count = attempt_count + 1,
            resource_type = coalesce(resource_type, $4),
            resource_id = coalesce(resource_id, $5)
        where id = $1
      `,
    [
      existing.id,
      leaseOwner,
      env.journalServiceIdempotencyLeaseSec,
      input.resourceType,
      recoveredResourceId,
    ],
  );
  return {
    rowId: String(existing.id),
    leaseOwner,
    resourceId: recoveredResourceId,
    replay: false,
    reclaimed: true,
    httpStatus: null,
    response: null,
  };
}

export async function completeJournalIdempotency(
  pool: Pool,
  claim: JournalIdempotencyClaim,
  input: {
    httpStatus: number;
    response?: Record<string, unknown>;
  },
): Promise<void> {
  return completeJournalIdempotencyInTransaction(pool, claim, input);
}

export async function completeJournalIdempotencyInTransaction(
  db: DbQuery,
  claim: JournalIdempotencyClaim,
  input: {
    httpStatus: number;
    response?: Record<string, unknown>;
  },
): Promise<void> {
  if (!claim.leaseOwner) return;
  const result = await db.query(
    `
      update content_machine_idempotency_keys
      set state = 'completed', http_status = $3, response = $4::jsonb,
          lease_owner = null, lease_expires_at = null
      where id = $1 and state = 'processing' and lease_owner = $2
    `,
    [
      claim.rowId,
      claim.leaseOwner,
      input.httpStatus,
      JSON.stringify(input.response ?? {}),
    ],
  );
  if (result.rowCount !== 1) {
    throw new JournalIdempotencyError(
      "idempotency_result_unavailable",
      "Idempotency lease was lost before completion",
      500,
    );
  }
}

export async function releaseJournalIdempotencyLease(
  pool: Pool,
  claim: JournalIdempotencyClaim,
): Promise<void> {
  if (!claim.leaseOwner) return;
  await pool.query(
    `
      update content_machine_idempotency_keys
      set lease_expires_at = now()
      where id = $1 and state = 'processing' and lease_owner = $2
    `,
    [claim.rowId, claim.leaseOwner],
  );
}
