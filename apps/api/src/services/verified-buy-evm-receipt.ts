type EvidenceReceipt = {
  hash: string;
  status: number | null;
  blockNumber: number;
  blockHash: string;
  logs: readonly {
    address: string;
    topics: readonly string[];
    data: string;
    index: number;
  }[];
};
type EvidenceBlock = { hash: string | null; number: number; timestamp: number };
export type VerifiedBuyEvmProvider = {
  getTransactionReceipt(hash: string): Promise<EvidenceReceipt | null>;
  getBlock(block: number | "finalized"): Promise<EvidenceBlock | null>;
};
type ReceiptAnchor = { blockNumber: number; blockHash: string };
function canonicalReceiptValue(receipt: EvidenceReceipt, block: EvidenceBlock) {
  return {
    canonicalBlock: {
      number: block.number,
      hash: receipt.blockHash.toLowerCase(),
    },
    receipt: {
      hash: receipt.hash,
      status: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        index: log.index,
      })),
    },
    timestamp: new Date(block.timestamp * 1000).toISOString(),
  };
}

/** Preserve the receipt -> finalized -> canonical read order and its three-read
 * budget. Reuse the canonical mismatch already observed by that reader. If it
 * stopped early, the remaining budget may inspect the saved exact log anchor.
 * No fourth RPC or log/provider status can become purchase proof. */
export async function readAnchoredFinalizedBuyReceipt(
  provider: VerifiedBuyEvmProvider,
  hash: string,
  anchor: ReceiptAnchor | undefined,
  beforeRead: () => void,
  options?: { anchorOnly: boolean },
) {
  if (options?.anchorOnly && anchor) {
    beforeRead();
    const block = await provider.getBlock(anchor.blockNumber);
    if (
      !block ||
      block.number !== anchor.blockNumber ||
      !block.hash ||
      !/^0x[0-9a-f]{64}$/i.test(block.hash)
    )
      return { state: "anchor_pending" as const };
    return block.hash.toLowerCase() !== anchor.blockHash.toLowerCase()
      ? { state: "orphaned" as const }
      : { state: "pending" as const };
  }
  const captured: { canonical: EvidenceBlock | null; reads: number } = {
    canonical: null,
    reads: 0,
  };
  const charge = () => {
    beforeRead();
    captured.reads++;
  };
  const value = await readCanonicalFinalizedBuyReceipt(
    {
      getTransactionReceipt: (value) => provider.getTransactionReceipt(value),
      getBlock: async (selector) => {
        const block = await provider.getBlock(selector);
        if (typeof selector === "number") captured.canonical = block;
        return block;
      },
    },
    hash,
    charge,
  );
  if (value) return { state: "finalized" as const, ...value };
  if (
    !anchor ||
    !Number.isSafeInteger(anchor.blockNumber) ||
    anchor.blockNumber < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(anchor.blockHash)
  )
    return { state: "pending" as const };
  if (!captured.canonical && captured.reads < 3) {
    charge();
    captured.canonical = await provider.getBlock(anchor.blockNumber);
  }
  const block = captured.canonical;
  if (
    block?.number === anchor.blockNumber &&
    block.hash &&
    /^0x[0-9a-f]{64}$/i.test(block.hash) &&
    block.hash.toLowerCase() !== anchor.blockHash.toLowerCase()
  )
    return { state: "orphaned" as const };
  if (block?.number !== anchor.blockNumber && captured.reads >= 3)
    return { state: "anchor_pending" as const };
  return { state: "pending" as const };
}
export type AnchoredBuyReceiptObservation = Awaited<
  ReturnType<typeof readAnchoredFinalizedBuyReceipt>
>;

/** Three bounded reads; block-by-height proves canonicality, not just existence by hash. */
export async function readCanonicalFinalizedBuyReceipt(
  provider: VerifiedBuyEvmProvider,
  hash: string,
  beforeRead: () => void,
) {
  beforeRead();
  const receipt = await provider.getTransactionReceipt(hash);
  if (
    !receipt ||
    receipt.hash.toLowerCase() !== hash.toLowerCase() ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    receipt.blockNumber < 0
  )
    return null;
  beforeRead();
  const finalized = await provider.getBlock("finalized");
  if (
    !finalized ||
    !Number.isSafeInteger(finalized.number) ||
    receipt.blockNumber > finalized.number
  )
    return null;
  beforeRead();
  const block = await provider.getBlock(receipt.blockNumber);
  if (
    !block ||
    block.number !== receipt.blockNumber ||
    block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
  )
    return null;
  return canonicalReceiptValue(receipt, block);
}
