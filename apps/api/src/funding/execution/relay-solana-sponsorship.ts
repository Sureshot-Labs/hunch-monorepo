import { createHash } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { SvmTransactionAction } from "../domain/types.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { loadFundingLifecycleProjectionForOperation } from "../lifecycle/funding-lifecycle-read-model.js";
import { deriveFundingLifecycleBeforeActionBroadcast } from "../lifecycle/funding-lifecycle-projector.js";
import { createSolanaRpcConnection } from "../../services/rpc-client-factory.js";
import {
  matchesRelaySolanaSponsorTransaction,
  proveRelaySolanaFeeOnly,
  relaySolanaSponsorshipEnabled,
} from "../../funding-providers/relay/solana-sponsorship.js";

export type RelaySponsorRedis = {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

const USER_SPONSORED_ACTIONS_PER_24H = 20;
const APP_SPONSORED_ACTIONS_PER_24H = 1000;

export const relaySponsorCandidateSql = `
  select operation_row.id as operation_id, step_row.id as step_id,
         step_row.normalized_action, step_row.action_fingerprint
  from funding_operations operation_row
  join funding_operation_steps step_row on step_row.operation_id = operation_row.id
  join funding_operation_segments segment_row on segment_row.id = step_row.segment_id
    and segment_row.operation_id = operation_row.id
  where operation_row.user_id = $1
    and step_row.normalized_action->>'actionId' = $2
    and step_row.normalized_action->>'kind' = 'svm_transaction'
    and segment_row.provider_id = 'relay'
    and step_row.action_expires_at > now()
    and exists (
      select 1 from funding_operation_step_attempts attempt_row
      where attempt_row.step_id = step_row.id and attempt_row.outcome = 'started'
        and not attempt_row.broadcast_may_have_occurred
    )
  order by operation_row.created_at desc
  limit 2
`;

/** A budget is admission control, not permission to replay an action. */
export const reserveRelaySponsorBudgetLua = `
  if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
  if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[1]) or
     tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[2]) then return 0 end
  for i = 2, 3 do
    local used = redis.call('INCR', KEYS[i])
    if used == 1 then redis.call('EXPIRE', KEYS[i], 86400) end
  end
  redis.call('SET', KEYS[1], '1', 'EX', 604800)
  return 1
`;

export function relaySponsorIdempotencyKey(
  userId: string,
  fingerprint: string,
): string {
  return createHash("sha256")
    .update(`relay-svm-fee-only:v1:${userId}:${fingerprint}`)
    .digest("hex");
}

/**
 * This lookup is the authority boundary. The client ID only locates a candidate;
 * ownership, committed fingerprint, live lifecycle and the whole message must
 * all match. No quote is fetched in response to untrusted execution bytes.
 */
export async function prepareRelaySolanaSponsorship(input: {
  db: Pick<Pool, "query">;
  redis: RelaySponsorRedis | null;
  userId: string;
  signer: string;
  requestId: string;
  transaction: string;
  execute?: boolean;
}): Promise<{ transaction: string; idempotencyKey: string } | null> {
  if (!relaySolanaSponsorshipEnabled()) return null;
  const { rows } = await input.db.query<{
    operation_id: string;
    step_id: string;
    normalized_action: unknown;
    action_fingerprint: string;
  }>(relaySponsorCandidateSql, [input.userId, input.requestId]);
  if (!rows.length) return null;
  if (rows.length !== 1 || !input.redis)
    throw new Error("Relay sponsorship cannot be verified.");
  const row = rows[0];
  if (!row) return null;
  const action = normalizedActionSchema.parse(
    row.normalized_action,
  ) as SvmTransactionAction;
  if (
    action.kind !== "svm_transaction" ||
    canonicalJsonHash(action) !== row.action_fingerprint
  )
    throw new Error("Relay sponsorship action changed.");
  const projected = await loadFundingLifecycleProjectionForOperation(input.db, {
    operationId: row.operation_id,
  });
  const facts = projected?.facts.actions.find(
    (entry) => entry.actionId === row.step_id,
  );
  const attempts = facts?.attempts.filter(
    (attempt) =>
      attempt.outcome === "started" && !attempt.broadcastMayHaveOccurred,
  );
  const attempt = attempts?.[0];
  if (!projected || attempts?.length !== 1 || !attempt)
    throw new Error("Relay sponsorship has no current funding attempt.");
  const lifecycle = deriveFundingLifecycleBeforeActionBroadcast(
    projected.facts,
    {
      actionId: row.step_id,
      attemptNumber: attempt.attemptNumber,
    },
  );
  if (
    !lifecycle.actions.find((entry) => entry.actionId === row.step_id)
      ?.actionable
  )
    throw new Error("Relay sponsorship funding action is no longer available.");
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (!rpcUrl || action.addressLookupTables.length > 4)
    throw new Error("Relay sponsorship RPC unavailable.");
  const signal = AbortSignal.timeout(4000);
  const connection = createSolanaRpcConnection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal }),
  });
  const lookupTables = await Promise.all(
    action.addressLookupTables.map(async (address) => {
      const table = await connection.getAddressLookupTable(
        new PublicKey(address),
      );
      if (!table.value)
        throw new Error("Relay sponsorship lookup unavailable.");
      return table.value;
    }),
  );
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(input.transaction, "base64"),
  );
  if (
    !matchesRelaySolanaSponsorTransaction({
      action,
      signer: input.signer,
      transaction,
      lookupTables,
    })
  )
    throw new Error(
      "Relay sponsorship transaction does not match its funding action.",
    );
  if (
    !(await proveRelaySolanaFeeOnly({
      connection,
      action,
      signer: input.signer,
    }))
  )
    throw new Error(
      "Relay sponsorship requires an existing-account USDC transfer.",
    );
  const idempotencyKey = relaySponsorIdempotencyKey(
    input.userId,
    row.action_fingerprint,
  );
  const prefix = "funding:{relay-svm-sponsor}:v1:";
  const preparedKey = `${prefix}prepared:${idempotencyKey}`;
  // First accepted transaction bytes win. A new client key/blockhash cannot
  // obtain an independent Privy idempotency identity for this funding action.
  if (!input.execute)
    await input.redis.set(preparedKey, input.transaction, {
      NX: true,
      EX: 300,
    });
  const prepared = await input.redis.get(preparedKey);
  if (!prepared || (input.execute && prepared !== input.transaction))
    throw new Error("Relay sponsorship authorization expired or changed.");
  if (input.execute) {
    const reserved = await input.redis.eval(reserveRelaySponsorBudgetLua, {
      keys: [
        `${prefix}charged:${idempotencyKey}`,
        `${prefix}user:${input.userId}`,
        `${prefix}app`,
      ],
      arguments: [
        String(USER_SPONSORED_ACTIONS_PER_24H),
        String(APP_SPONSORED_ACTIONS_PER_24H),
      ],
    });
    if (reserved !== 1)
      throw new Error("Relay sponsorship limit reached. Add SOL or try later.");
  }
  return { transaction: prepared, idempotencyKey };
}
