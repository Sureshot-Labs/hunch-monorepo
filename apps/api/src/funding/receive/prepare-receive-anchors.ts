import type { Pool } from "@hunch/infra";
import type { FundingReceiveCanonicalEventInput } from "../persistence/funding-receive-session-repository.js";
import {
  readPendingReceiveAnchorCandidate,
  repairPendingReceiveAnchor,
} from "../persistence/funding-pending-receive-anchor.js";
import { inspectEvmFundingReceiveAnchor } from "./evm-receive-anchor-proof.js";
import { receiveRoleEventFingerprint } from "./receive-role-progress.js";

export const READ_RECEIVE_ANCHOR_HINTS_SQL = `select event_row.id,
  event_row.network_id,event_row.tx_hash,event_row.event_index,
  event_row.ledger_height::text,event_row.block_hash
  from jsonb_to_recordset($1::jsonb) as requested_event(network_id text,tx_hash text,event_index text)
  join funding_receive_canonical_events event_row on event_row.network_id=requested_event.network_id
    and event_row.tx_hash=requested_event.tx_hash and event_row.event_index=requested_event.event_index`;

/** Normal fresh/same-anchor batches need one indexed hint read and NO extra
 * provider calls. A rare remine uses the same narrow known-transaction proof
 * and metadata CAS as the receive queue, before ANY publication E/O locks.
 * Return pending even after repair: the ordinary next provider/receive pass
 * rereads B. Never ignore anchor/economic collisions or manufacture a session.
 */
export async function prepareReceiveAnchors(
  pool: Pool,
  input: {
    events: readonly FundingReceiveCanonicalEventInput[];
    deadlineMs?: number;
    inspect?: typeof inspectEvmFundingReceiveAnchor;
  },
): Promise<"ready" | "pending"> {
  const events = input.events.filter((event) =>
    ["evm:137", "evm:8453"].includes(event.networkId),
  );
  if (!events.length) return "ready";
  const hints = await pool.query<{
    id: string;
    network_id: string;
    tx_hash: string;
    event_index: string;
    ledger_height: string;
    block_hash: string;
  }>(READ_RECEIVE_ANCHOR_HINTS_SQL, [
    JSON.stringify(
      events.map((event) => ({
        network_id: event.networkId,
        tx_hash: event.transactionHash,
        event_index: event.eventIndex,
      })),
    ),
  ]);
  let pending = false;
  for (const hint of hints.rows) {
    const incoming = events.find(
      (event) =>
        event.networkId === hint.network_id &&
        event.transactionHash === hint.tx_hash &&
        event.eventIndex === hint.event_index,
    );
    if (
      !incoming ||
      (incoming.ledgerHeight === hint.ledger_height &&
        incoming.blockHash === hint.block_hash)
    )
      continue;
    const candidate = await readPendingReceiveAnchorCandidate(pool, hint.id);
    if (!candidate) {
      pending = true;
      continue;
    }
    // Keep the existing strict upsert's economic collision behavior. This
    // adapter authorizes ONLY anchor movement of the same immutable transfer.
    if (
      receiveRoleEventFingerprint({
        ...candidate.event,
        ledgerHeight: incoming.ledgerHeight,
        blockHash: incoming.blockHash,
      }) !== receiveRoleEventFingerprint(incoming)
    )
      continue;
    pending = true;
    const deadlineMs = input.deadlineMs;
    if (
      typeof deadlineMs !== "number" ||
      !Number.isFinite(deadlineMs) ||
      Date.now() >= deadlineMs
    )
      continue;
    const proof = await (input.inspect ?? inspectEvmFundingReceiveAnchor)({
      expected: candidate.event,
      deadlineMs,
    });
    if (
      proof.kind !== "replacement_verified" ||
      proof.ledgerHeight !== incoming.ledgerHeight ||
      proof.blockHash !== incoming.blockHash.toLowerCase()
    )
      continue;
    await repairPendingReceiveAnchor(pool, {
      candidate,
      proof,
      deadlineMs,
    });
  }
  return pending ? "pending" : "ready";
}
