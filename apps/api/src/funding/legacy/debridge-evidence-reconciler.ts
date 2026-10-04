import { randomUUID } from "node:crypto";
import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";
import { VersionedTransaction } from "@solana/web3.js";
import { AuthService } from "../../auth.js";
import { env } from "../../env.js";
import { isRecord } from "../../lib/type-guards.js";
import { uniqueDebridgeSourceOrderId } from "../../services/debridge-order-identity.js";
import { debridgeRequest } from "../../services/debridge-client.js";
import { fetchActiveDebridgeConfig } from "../../repos/debridge-config.js";
import {
  fetchEvmBlockHash,
  fetchEvmCallTrace,
  fetchEvmFinalizedBlockNumber,
  fetchEvmTransactionByHash,
  fetchEvmTransactionReceipt,
} from "../../services/polygon-rpc.js";
import {
  fetchSolanaFinalizedSerializedTransaction,
  fetchSolanaParsedTransaction,
  parseFinalizedSolanaOwnedTokenDebit,
} from "../../services/solana-rpc.js";
import { sumErc20TransfersTo } from "../execution/evm-erc20-receipt.js";
import { legacyEvidencePollingPausedSql } from "./evidence-polling-control.js";

export type LegacyDebridgeRow = {
  id: string;
  user_id: string;
  swap_type: string;
  status: string;
  src_chain_id: string;
  dst_chain_id: string;
  src_token: string;
  dst_token: string;
  amount_in: string;
  min_amount_out: string | null;
  tx_hash_src: string;
  order_id: string | null;
  metadata: unknown;
};
export type DebridgeDestinationProof = {
  orderId: string | null;
  txHash: string;
  chainId: string;
  token: string;
  recipient: string;
  amountRaw: string;
};
const SOLANA = "7565164";
const eq = (a: string | null, b: string | null, chainId: string) =>
  a !== null &&
  b !== null &&
  (chainId === SOLANA ? a === b : a.toLowerCase() === b.toLowerCase());
// Stats DTO bigIntegerValue is a JS number and loses native-token precision.
const dto = (value: unknown): string | null =>
  typeof value === "string"
    ? value
    : isRecord(value) && typeof value.stringValue === "string"
      ? value.stringValue
      : null;
const positive = (value: string | null): value is string =>
  value !== null && /^[1-9][0-9]*$/.test(value);
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : null;
}

export function sameSolanaSwapMessage(
  expectedBase64: string,
  actualBase64: string,
): boolean {
  try {
    const normalize = (encoded: string) => {
      const message = VersionedTransaction.deserialize(
        Buffer.from(encoded, "base64"),
      ).message;
      return JSON.stringify({
        header: message.header,
        keys: message.staticAccountKeys.map((key) => key.toBase58()),
        instructions: message.compiledInstructions.map((instruction) => ({
          program: instruction.programIdIndex,
          accounts: [...instruction.accountKeyIndexes],
          data: Buffer.from(instruction.data).toString("hex"),
        })),
        lookups: message.addressTableLookups.map((lookup) => ({
          key: lookup.accountKey.toBase58(),
          writable: [...lookup.writableIndexes],
          readonly: [...lookup.readonlyIndexes],
        })),
      });
    };
    // Refreshing blockhash/signatures is allowed; sender, programs, accounts,
    // amounts and minimum-return calldata are not allowed to drift.
    return normalize(expectedBase64) === normalize(actualBase64);
  } catch {
    return false;
  }
}

/** Bind provider facts to the submitted source, never to a stale quote ID/amount. */
export function parseLegacyDebridgeDestination(
  row: LegacyDebridgeRow,
  payload: unknown,
  sourceOrderId: string | null,
): DebridgeDestinationProof | null {
  if (
    !isRecord(payload) ||
    !isRecord(row.metadata) ||
    typeof row.metadata.recipientAddress !== "string" ||
    typeof row.metadata.senderAddress !== "string"
  )
    return null;
  const recipient = row.metadata.recipientAddress;
  if (row.swap_type === "same_chain") {
    const input = payload.tokenIn,
      output = payload.tokenOut;
    const amount = dto(field(output, "amount"));
    if (
      !eq(dto(payload.transactionHash), row.tx_hash_src, row.src_chain_id) ||
      dto(payload.chainId) !== row.src_chain_id ||
      row.dst_chain_id !== row.src_chain_id ||
      !eq(dto(payload.sender), row.metadata.senderAddress, row.src_chain_id) ||
      !eq(dto(payload.recipient), recipient, row.dst_chain_id) ||
      !eq(dto(field(input, "tokenAddress")), row.src_token, row.src_chain_id) ||
      dto(field(input, "amount")) !== row.amount_in ||
      !eq(
        dto(field(output, "tokenAddress")),
        row.dst_token,
        row.dst_chain_id,
      ) ||
      !positive(amount)
    )
      return null;
    return {
      orderId: row.order_id,
      txHash: row.tx_hash_src,
      chainId: row.dst_chain_id,
      token: row.dst_token,
      recipient,
      amountRaw: amount,
    };
  }
  const give = payload.giveOfferWithMetadata,
    take = payload.takeOfferWithMetadata;
  const preswap = payload.preswapData;
  const amount = dto(payload.actualFulfillAmount);
  const txHash = dto(
    field(payload.fulfilledDstEventMetadata, "transactionHash"),
  );
  const inputMatches =
    (eq(dto(field(give, "tokenAddress")), row.src_token, row.src_chain_id) &&
      dto(field(give, "amount")) === row.amount_in) ||
    (eq(
      dto(field(preswap, "inTokenAddress")),
      row.src_token,
      row.src_chain_id,
    ) &&
      dto(field(preswap, "inAmount")) === row.amount_in);
  if (
    !sourceOrderId ||
    dto(payload.orderId)?.toLowerCase() !== sourceOrderId.toLowerCase() ||
    !eq(
      dto(field(payload.createdSrcEventMetadata, "transactionHash")),
      row.tx_hash_src,
      row.src_chain_id,
    ) ||
    dto(field(give, "chainId")) !== row.src_chain_id ||
    dto(field(take, "chainId")) !== row.dst_chain_id ||
    !inputMatches ||
    !eq(dto(field(take, "tokenAddress")), row.dst_token, row.dst_chain_id) ||
    !eq(dto(payload.receiverDst), recipient, row.dst_chain_id) ||
    !positive(amount) ||
    !txHash ||
    !["Fulfilled", "SentUnlock", "ClaimedUnlock"].includes(
      String(payload.state),
    ) ||
    payload.externalCallState !== "NoExtCall"
  )
    return null;
  return {
    orderId: sourceOrderId,
    txHash,
    chainId: row.dst_chain_id,
    token: row.dst_token,
    recipient,
    amountRaw: amount,
  };
}

export function sumSuccessfulNativeTraceTo(
  trace: unknown,
  recipient: string,
): bigint | null {
  let nodes = 0;
  const walk = (node: unknown, depth: number): bigint | null => {
    if (!isRecord(node) || ++nodes > 2000 || depth > 32 || node.error)
      return null;
    const value = node.value === undefined ? "0x0" : node.value;
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
    // DELEGATECALL/STATICCALL transfer no value, even if a tracer repeats value.
    let total =
      ["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"].includes(
        String(node.type),
      ) &&
      typeof node.to === "string" &&
      eq(node.to, recipient, "evm")
        ? BigInt(value)
        : 0n;
    if (node.calls !== undefined && !Array.isArray(node.calls)) return null;
    for (const child of Array.isArray(node.calls) ? node.calls : []) {
      const amount = walk(child, depth + 1);
      if (amount === null) return null;
      total += amount;
    }
    return total;
  };
  return walk(trace, 0);
}

export function finalizedSolanaCredit(
  transaction: unknown,
  recipient: string,
  token: string,
): string | null {
  if (
    !isRecord(transaction) ||
    !isRecord(transaction.meta) ||
    transaction.meta.err !== null
  )
    return null;
  const meta = transaction.meta;
  if (token !== "11111111111111111111111111111111") {
    const reverse = {
      ...transaction,
      meta: {
        ...meta,
        preTokenBalances: meta.postTokenBalances,
        postTokenBalances: meta.preTokenBalances,
      },
    };
    // Legacy supported bridge stablecoins use 6 decimals. Unknown assets remain
    // unknown, rather than inferring metadata from a floating uiAmount.
    return (
      parseFinalizedSolanaOwnedTokenDebit(reverse, {
        owner: recipient,
        mint: token,
        decimals: 6,
      })?.raw ?? null
    );
  }
  const keys = field(field(transaction, "transaction"), "message");
  const accounts = field(keys, "accountKeys");
  if (
    !Array.isArray(accounts) ||
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances)
  )
    return null;
  const index = accounts.findIndex(
    (key) =>
      (typeof key === "string" ? key : field(key, "pubkey")) === recipient,
  );
  const before = meta.preBalances[index],
    after = meta.postBalances[index];
  if (
    index < 0 ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after)
  )
    return null;
  const delta = BigInt(after as number) - BigInt(before as number);
  return delta > 0n ? delta.toString() : null;
}

export function sourceErc20Debit(
  logs: readonly { address: string; data: string; topics: readonly string[] }[],
  owner: string,
  token: string,
): bigint {
  let debit = 0n;
  const topic = ethers.id("Transfer(address,address,uint256)");
  for (const log of logs)
    if (
      log.address.toLowerCase() === token.toLowerCase() &&
      log.topics.length === 3 &&
      log.topics[0]?.toLowerCase() === topic.toLowerCase()
    ) {
      try {
        if (
          ethers.getAddress(`0x${log.topics[1]?.slice(-40)}`).toLowerCase() ===
          owner.toLowerCase()
        )
          debit += BigInt(log.data);
      } catch {
        return 0n;
      }
    }
  return debit;
}

export function ownedErc20SourceDebit(
  logs: Parameters<typeof sourceErc20Debit>[0],
  verifiedOwners: readonly string[],
  token: string,
): { owner: string; raw: string } | null {
  const debits = [
    ...new Set(verifiedOwners.map((owner) => owner.toLowerCase())),
  ].flatMap((owner) => {
    const raw = sourceErc20Debit(logs, owner, token);
    return raw > 0n ? [{ owner, raw: raw.toString() }] : [];
  });
  // Bundler/EntryPoint tx.from is not the token owner. Only an exact canonical
  // debit from one verified owned wallet can identify this source.
  return debits.length === 1 ? (debits[0] ?? null) : null;
}

function evmNetwork(chainId: string) {
  const configured = (
    {
      "1": env.ethereumRpcUrl,
      "137": env.polygonRpcUrl,
      "8453": env.baseRpcUrl,
    } as Record<string, string>
  )[chainId];
  const rpcUrl = env.evmRpcUrlsByChain[chainId] ?? configured;
  return rpcUrl ? { rpcUrl, timeoutMs: 4000, maxAttempts: 1 } : null;
}

async function finalizedEvmReceipt(chainId: string, transactionHash: string) {
  const network = evmNetwork(chainId);
  if (!network) return null;
  const receipt = await fetchEvmTransactionReceipt({
    ...network,
    transactionHash,
  });
  if (
    !receipt ||
    BigInt(receipt.blockNumber) > (await fetchEvmFinalizedBlockNumber(network))
  )
    return null;
  const blockHash = await fetchEvmBlockHash({
    ...network,
    blockNumber: receipt.blockNumber,
  });
  return blockHash?.toLowerCase() === receipt.blockHash.toLowerCase()
    ? receipt
    : null;
}

async function canonicalDestination(
  proof: DebridgeDestinationProof,
): Promise<boolean> {
  if (proof.chainId === SOLANA) {
    const transaction = await fetchSolanaParsedTransaction({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: 5000,
      maxAttempts: 1,
      totalTimeoutMs: 5000,
      signature: proof.txHash,
    });
    if (
      !isRecord(transaction) ||
      field(field(transaction, "transaction"), "signatures") === null
    )
      return false;
    const signatures = field(transaction.transaction, "signatures");
    if (!Array.isArray(signatures) || signatures[0] !== proof.txHash)
      return false;
    return (
      finalizedSolanaCredit(transaction, proof.recipient, proof.token) ===
      proof.amountRaw
    );
  }
  const network = evmNetwork(proof.chainId);
  const receipt = await finalizedEvmReceipt(proof.chainId, proof.txHash);
  if (!network || !receipt?.succeeded) return false;
  if (proof.token.toLowerCase() !== ethers.ZeroAddress)
    return (
      sumErc20TransfersTo({
        logs: receipt.logs,
        recipient: proof.recipient,
        tokenAddress: proof.token,
      }) === BigInt(proof.amountRaw)
    );
  const trace = await fetchEvmCallTrace({
    ...network,
    transactionHash: proof.txHash,
  });
  return (
    sumSuccessfulNativeTraceTo(trace, proof.recipient) ===
    BigInt(proof.amountRaw)
  );
}

export async function claimLegacyDebridgeEvidence(
  db: Pick<Pool, "query">,
  clock = new Date(),
): Promise<{ rows: LegacyDebridgeRow[]; leaseToken: string }> {
  const now = clock.toISOString(),
    leaseToken = randomUUID();
  const result = await db.query<LegacyDebridgeRow>(
    `with candidate_rows as (
      select id from bridge_orders where provider = 'debridge' and status in ('created', 'submitted', 'fulfilled') and tx_hash_src is not null
        and metadata #>> '{legacyEvidenceRecovery,evidence}' is distinct from 'canonical_destination_receipt_v1'
        and adapter_version in ('debridge_dln_create_tx_v1', 'debridge_same_chain_v1', 'debridge_same_chain_tx_v0')
        and jsonb_typeof(coalesce(metadata, '{}'::jsonb)) = 'object'
        and not ${legacyEvidencePollingPausedSql("metadata", "id", "legacy_debridge")}
        and case when metadata #>> '{legacyEvidenceRecovery,nextAttemptAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          then metadata #>> '{legacyEvidenceRecovery,nextAttemptAt}' else '' end <= $1
      order by updated_at, id limit 4 for update skip locked
    ) update bridge_orders target_row set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{legacyEvidenceRecovery}', $2::jsonb), updated_at = now()
      from candidate_rows where target_row.id = candidate_rows.id returning target_row.*`,
    [
      now,
      JSON.stringify({
        leaseToken,
        nextAttemptAt: new Date(clock.getTime() + 5 * 60_000).toISOString(),
      }),
    ],
  );
  return { rows: result.rows, leaseToken };
}

export async function recordLegacyDebridgeDestination(
  db: Pick<Pool, "query">,
  input: {
    row: LegacyDebridgeRow;
    proof: DebridgeDestinationProof;
    leaseToken: string;
    sourceAmount: string;
    sender: string;
  },
): Promise<boolean> {
  const { row, proof, leaseToken, sourceAmount, sender } = input;
  const updated = await db.query(
    `update bridge_orders set status = 'fulfilled', order_id = coalesce($1, order_id), tx_hash_dst = $2,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'legacyEvidenceRecovery', $3::jsonb,
        'tokenIn', (case when jsonb_typeof(metadata->'tokenIn') = 'object' then metadata->'tokenIn' else '{}'::jsonb end)
          || jsonb_build_object('amount', $9::text),
        'tokenOut', (case when jsonb_typeof(metadata->'tokenOut') = 'object' then metadata->'tokenOut' else '{}'::jsonb end)
          || jsonb_build_object('amount', $10::text)
      ), updated_at = now()
      where id = $4 and user_id = $5 and tx_hash_src = $6 and order_id is not distinct from $7
        and status in ('created', 'submitted', 'fulfilled') and metadata #>> '{legacyEvidenceRecovery,leaseToken}' = $8
        and metadata #>> '{legacyEvidenceRecovery,evidence}' is distinct from 'canonical_destination_receipt_v1'`,
    [
      proof.orderId,
      proof.txHash,
      JSON.stringify({
        leaseToken,
        evidence: "canonical_destination_receipt_v1",
        actualAmountRaw: proof.amountRaw,
        token: proof.token,
        recipient: proof.recipient,
        chainId: proof.chainId,
        actualSourceAmountRaw: sourceAmount,
        sourceOwner: sender,
        observedAt: new Date().toISOString(),
      }),
      row.id,
      row.user_id,
      row.tx_hash_src,
      row.order_id,
      leaseToken,
      sourceAmount,
      proof.amountRaw,
    ],
  );
  return updated.rowCount === 1;
}

export async function reconcileLegacyDebridgeEvidence(
  db: Pool,
): Promise<{ claimed: number; fulfilled: number; unknown: number }> {
  const result = await claimLegacyDebridgeEvidence(db);
  const { leaseToken } = result;
  if (!result.rows.length) return { claimed: 0, fulfilled: 0, unknown: 0 };
  const config = await fetchActiveDebridgeConfig(db);
  const statsBase = config?.stats_base?.trim() || env.debridgeStatsBase;
  const get = (requestPath: string) =>
    debridgeRequest({
      baseUrl: statsBase,
      timeoutMs: 5000,
      method: "GET",
      requestPath,
    });
  let fulfilled = 0;
  for (const row of result.rows) {
    const deadline = Date.now() + 45_000;
    const checkReadBudget = () => {
      if (Date.now() >= deadline)
        throw new Error("Legacy evidence read budget exhausted");
    };
    try {
      const wallets = await AuthService.getUserWallets(row.user_id);
      const owned = (address: string, chain: string) =>
        wallets.some(
          (wallet) =>
            wallet.isVerified && eq(wallet.walletAddress, address, chain),
        );
      const duplicate = await db.query(
        `select id from bridge_orders where provider = 'debridge' and tx_hash_src = $1 and id <> $2 limit 1`,
        [row.tx_hash_src, row.id],
      );
      if (duplicate.rows.length) continue;
      let sender: string | null = null,
        sourceAmount: string | null = null;
      let solanaSource: unknown = null;
      if (row.src_chain_id === SOLANA) {
        solanaSource = await fetchSolanaParsedTransaction({
          rpcUrls: env.solanaRpcUrls,
          timeoutMs: 5000,
          maxAttempts: 1,
          totalTimeoutMs: 5000,
          signature: row.tx_hash_src,
        });
        if (
          !isRecord(solanaSource) ||
          !isRecord(solanaSource.meta) ||
          solanaSource.meta.err !== null
        )
          continue;
        const signatures = field(solanaSource.transaction, "signatures");
        if (!Array.isArray(signatures) || signatures[0] !== row.tx_hash_src)
          continue;
        const debits = wallets
          .filter((wallet) => wallet.isVerified)
          .flatMap((wallet) => {
            const debit = parseFinalizedSolanaOwnedTokenDebit(solanaSource, {
              owner: wallet.walletAddress,
              mint: row.src_token,
              decimals: 6,
            });
            return debit
              ? [{ owner: wallet.walletAddress, raw: debit.raw }]
              : [];
          });
        const debit = debits[0];
        if (debits.length !== 1 || !debit) continue;
        sender = debit.owner;
        sourceAmount = debit.raw;
      } else {
        const network = evmNetwork(row.src_chain_id);
        const source = await finalizedEvmReceipt(
          row.src_chain_id,
          row.tx_hash_src,
        );
        if (!network || !source?.succeeded) continue;
        const transaction = await fetchEvmTransactionByHash({
          ...network,
          transactionHash: row.tx_hash_src,
        });
        if (!transaction || transaction.chainId !== BigInt(row.src_chain_id))
          continue;
        const debit = ownedErc20SourceDebit(
          source.logs,
          wallets
            .filter((wallet) => wallet.isVerified)
            .map((wallet) => wallet.walletAddress),
          row.src_token,
        );
        if (!debit) continue;
        sender = debit.owner;
        sourceAmount = debit.raw;
      }
      const metadata = isRecord(row.metadata) ? row.metadata : {};
      checkReadBudget();
      if (
        typeof metadata.senderAddress === "string" &&
        !eq(metadata.senderAddress, sender, row.src_chain_id)
      )
        continue;
      let proof: DebridgeDestinationProof | null = null;
      if (row.swap_type === "same_chain") {
        const response = await get(
          `/SameChainSwap/${row.src_chain_id}/tx/${row.tx_hash_src}`,
        );
        const recipient = response.ok
          ? dto(field(response.payload, "recipient"))
          : null;
        if (
          recipient &&
          owned(recipient, row.dst_chain_id) &&
          (typeof metadata.recipientAddress !== "string" ||
            eq(metadata.recipientAddress, recipient, row.dst_chain_id))
        ) {
          proof = parseLegacyDebridgeDestination(
            {
              ...row,
              amount_in: sourceAmount,
              metadata: {
                ...metadata,
                senderAddress: sender,
                recipientAddress: recipient,
              },
            },
            response.payload,
            null,
          );
        }
        // Solana same-chain Stats has no legacy entry for this finalized swap.
        // Exact source token loss plus a unique owned native credit in that
        // same signed transaction proves the actual result, not a quote value.
        if (
          !response.ok &&
          row.src_chain_id === SOLANA &&
          row.dst_chain_id === SOLANA &&
          row.dst_token === "11111111111111111111111111111111"
        ) {
          const template = field(metadata.tx, "data");
          if (typeof template !== "string") continue;
          const actual = await fetchSolanaFinalizedSerializedTransaction({
            rpcUrls: env.solanaRpcUrls,
            timeoutMs: 5000,
            signature: row.tx_hash_src,
          });
          if (!actual || !sameSolanaSwapMessage(template, actual)) continue;
          const credits = wallets
            .filter((wallet) => wallet.isVerified)
            .flatMap((wallet) => {
              const raw = finalizedSolanaCredit(
                solanaSource,
                wallet.walletAddress,
                row.dst_token,
              );
              return raw ? [{ recipient: wallet.walletAddress, raw }] : [];
            });
          const credit = credits[0];
          if (
            credits.length === 1 &&
            credit &&
            eq(credit.recipient, sender, SOLANA) &&
            (typeof metadata.recipientAddress !== "string" ||
              eq(metadata.recipientAddress, sender, SOLANA))
          )
            proof = {
              orderId: row.order_id,
              txHash: row.tx_hash_src,
              chainId: SOLANA,
              token: row.dst_token,
              recipient: sender,
              amountRaw: credit.raw,
            };
        }
      } else {
        const lookup = await get(`/Transaction/${row.tx_hash_src}/orderIds`);
        const orderId = lookup.ok
          ? uniqueDebridgeSourceOrderId(lookup.payload)
          : null;
        if (!orderId) continue;
        const response = await get(`/Orders/${orderId}`);
        const recipient = response.ok
          ? dto(field(response.payload, "receiverDst"))
          : null;
        if (
          recipient &&
          owned(recipient, row.dst_chain_id) &&
          (typeof metadata.recipientAddress !== "string" ||
            eq(metadata.recipientAddress, recipient, row.dst_chain_id))
        )
          proof = parseLegacyDebridgeDestination(
            {
              ...row,
              amount_in: sourceAmount,
              metadata: {
                ...metadata,
                senderAddress: sender,
                recipientAddress: recipient,
              },
            },
            response.payload,
            orderId,
          );
      }
      checkReadBudget();
      if (!proof || !(await canonicalDestination(proof))) continue;
      checkReadBudget();
      if (
        await recordLegacyDebridgeDestination(db, {
          row,
          proof,
          leaseToken,
          sourceAmount,
          sender,
        })
      )
        fulfilled++;
    } catch {
      /* Provider absence, tracing unavailable, malformed receipts: retry, never invent completion. */
    }
  }
  return {
    claimed: result.rows.length,
    fulfilled,
    unknown: result.rows.length - fulfilled,
  };
}
