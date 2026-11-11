import { createHash } from "node:crypto";
import { id } from "ethers";
import { z } from "zod";

export const LIMITLESS_RECEIPT_SEARCH_KEY = "_hunchLimitlessReceiptSearchV1";
// These are observation budgets, not proof/finality shortcuts. A checkpoint
// continues on the ordinary worker after restart; no submission code is used.
export const LIMITLESS_RECEIPT_SEARCH_READS = 6;
export const LIMITLESS_RECEIPT_SEARCH_BLOCKS = 10_000;
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const blockNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const limitlessReceiptSearchSchema = z
  .object({
    version: z.literal(1),
    identityKey: z.string().regex(/^[0-9a-f]{64}$/),
    phase: z.enum(["locate", "scan", "restart"]),
    targetBlock: blockNumber,
    lowerBlock: blockNumber,
    upperBlock: blockNumber,
    nextBlock: blockNumber,
    transactions: z.array(hash).max(100),
    anchorChecks: z.array(hash).max(100).default([]),
    anchors: z
      .record(hash, z.object({ blockNumber, blockHash: hash }).strict())
      .default({}),
  })
  .strict();
export type LimitlessReceiptSearch = z.infer<
  typeof limitlessReceiptSearchSchema
>;
export type LimitlessReceiptSearchInput = {
  exchangeAddress: string;
  orderHash: string;
  providerOrderId: string;
  owner: string;
  tokenId: string;
  generation: string;
  postedAt: string;
  checkpoint: unknown;
};
type SearchBlock = { number: number; timestamp: number };
export type LimitlessReceiptSearchProvider = {
  getBlock(block: number | "finalized"): Promise<SearchBlock | null>;
  getLogs(filter: {
    address: string;
    topics: [string[], string];
    fromBlock: number;
    toBlock: number;
  }): Promise<
    ReadonlyArray<{
      address: string;
      topics: readonly string[];
      transactionHash: string;
      blockNumber: number;
      removed?: boolean;
      blockHash: string;
    }>
  >;
};
export function limitlessReceiptSearchIdentity(
  input: LimitlessReceiptSearchInput,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        8453,
        input.exchangeAddress.toLowerCase(),
        input.orderHash.toLowerCase(),
        input.providerOrderId,
        input.owner.toLowerCase(),
        input.tokenId,
        input.generation,
        input.postedAt,
      ]),
    )
    .digest("hex");
}
const fillTopics = [
  id(
    "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
  ),
  id(
    "OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)",
  ),
];
export function readLimitlessReceiptSearch(
  input: LimitlessReceiptSearchInput,
): LimitlessReceiptSearch | null {
  const parsed = limitlessReceiptSearchSchema.safeParse(input.checkpoint);
  if (
    !parsed.success ||
    parsed.data.identityKey !== limitlessReceiptSearchIdentity(input)
  )
    return null;
  const value = parsed.data;
  return value.lowerBlock <= value.upperBlock &&
    value.upperBlock <= value.targetBlock &&
    value.nextBlock <= value.targetBlock + 1 &&
    new Set(value.transactions).size === value.transactions.length &&
    value.transactions.every(
      (transaction) => value.anchors[transaction] !== undefined,
    ) &&
    value.anchorChecks.every((transaction) =>
      value.transactions.includes(transaction),
    )
    ? value
    : null;
}

/** Bounded exact log discovery. Logs locate receipts; they NEVER prove a buy. */
export async function discoverLimitlessBuyTransactions(
  provider: LimitlessReceiptSearchProvider,
  input: LimitlessReceiptSearchInput,
  beforeRead: () => void,
  options?: { maxReads: number },
): Promise<{
  checkpoint: LimitlessReceiptSearch;
  reads: number;
  failure?: unknown;
}> {
  const postedMs = Date.parse(input.postedAt);
  const maxReads = options?.maxReads ?? LIMITLESS_RECEIPT_SEARCH_READS;
  if (
    !Number.isSafeInteger(maxReads) ||
    maxReads < 1 ||
    maxReads > LIMITLESS_RECEIPT_SEARCH_READS
  )
    throw Error("Invalid receipt search budget");
  if (
    !Number.isFinite(postedMs) ||
    !/^0x[0-9a-f]{40}$/i.test(input.exchangeAddress) ||
    !/^0x[0-9a-f]{64}$/i.test(input.orderHash)
  )
    throw Error("Invalid receipt search identity");
  const fromTime = Math.max(0, Math.floor(postedMs / 1000) - 120);
  let reads = 0;
  const read = () => {
    beforeRead();
    reads++;
  };
  let checkpoint = readLimitlessReceiptSearch(input);
  if (checkpoint?.transactions.length) return { checkpoint, reads };
  if (
    !checkpoint ||
    checkpoint.phase === "restart" ||
    (checkpoint.phase === "scan" &&
      checkpoint.nextBlock > checkpoint.targetBlock)
  ) {
    read();
    const finalized = await provider.getBlock("finalized");
    if (
      !finalized ||
      !Number.isSafeInteger(finalized.number) ||
      finalized.number < 0 ||
      !Number.isSafeInteger(finalized.timestamp) ||
      finalized.timestamp < fromTime
    )
      throw Error("Finalized search boundary unavailable");
    if (
      checkpoint &&
      checkpoint.phase !== "restart" &&
      finalized.number < checkpoint.targetBlock
    )
      throw Error("Finalized search boundary regressed");
    checkpoint =
      checkpoint && checkpoint.phase !== "restart"
        ? { ...checkpoint, targetBlock: finalized.number }
        : {
            version: 1,
            identityKey: limitlessReceiptSearchIdentity(input),
            phase: "locate",
            targetBlock: finalized.number,
            lowerBlock: 0,
            upperBlock: finalized.number,
            nextBlock: 0,
            transactions: [],
            anchorChecks: [],
            anchors: {},
          };
  }
  try {
    while (reads < maxReads) {
      if (checkpoint.phase === "locate") {
        if (checkpoint.lowerBlock === checkpoint.upperBlock) {
          checkpoint = {
            ...checkpoint,
            phase: "scan",
            nextBlock: checkpoint.lowerBlock,
          };
          continue;
        }
        const middle = Math.floor(
          (checkpoint.lowerBlock + checkpoint.upperBlock) / 2,
        );
        read();
        const block = await provider.getBlock(middle);
        if (
          !block ||
          block.number !== middle ||
          !Number.isSafeInteger(block.timestamp)
        )
          throw Error("Search block unavailable");
        checkpoint =
          block.timestamp < fromTime
            ? { ...checkpoint, lowerBlock: middle + 1 }
            : { ...checkpoint, upperBlock: middle };
        continue;
      }
      if (checkpoint.nextBlock > checkpoint.targetBlock) break;
      const fromBlock = checkpoint.nextBlock;
      const toBlock = Math.min(
        checkpoint.targetBlock,
        fromBlock + LIMITLESS_RECEIPT_SEARCH_BLOCKS - 1,
      );
      read();
      const logs = await provider.getLogs({
        address: input.exchangeAddress,
        topics: [fillTopics, input.orderHash],
        fromBlock,
        toBlock,
      });
      const transactions = new Set<string>();
      const anchors: LimitlessReceiptSearch["anchors"] = {};
      for (const log of logs) {
        if (
          log.removed ||
          log.address.toLowerCase() !== input.exchangeAddress.toLowerCase() ||
          !fillTopics.includes(log.topics[0] ?? "") ||
          log.topics[1]?.toLowerCase() !== input.orderHash.toLowerCase() ||
          !Number.isSafeInteger(log.blockNumber) ||
          log.blockNumber < fromBlock ||
          log.blockNumber > toBlock ||
          !/^0x[0-9a-f]{64}$/i.test(log.transactionHash) ||
          !/^0x[0-9a-f]{64}$/i.test(log.blockHash)
        )
          throw Error("Receipt search response identity conflict");
        transactions.add(log.transactionHash.toLowerCase());
        const locator = log.transactionHash.toLowerCase();
        const anchor = {
          blockNumber: log.blockNumber,
          blockHash: log.blockHash.toLowerCase(),
        };
        if (
          anchors[locator] &&
          (anchors[locator].blockHash !== anchor.blockHash ||
            anchors[locator].blockNumber !== anchor.blockNumber)
        )
          throw Error("Receipt locator block conflict");
        anchors[locator] = anchor;
      }
      checkpoint = {
        ...checkpoint,
        nextBlock: toBlock + 1,
        transactions: [...transactions].sort(),
        anchors,
      };
      // All concrete candidates on this exact page are retained, never silently
      // truncated. The canonical receipt parser still checks every candidate.
      limitlessReceiptSearchSchema.parse(checkpoint);
      if (transactions.size) break;
    }
  } catch (failure) {
    return { checkpoint, reads, failure };
  }
  return { checkpoint, reads };
}
