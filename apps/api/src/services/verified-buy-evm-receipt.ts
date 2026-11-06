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
  return {
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
