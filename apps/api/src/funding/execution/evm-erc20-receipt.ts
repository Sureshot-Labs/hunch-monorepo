import { ethers } from "ethers";

const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export function sumErc20TransfersTo(input: {
  logs: readonly { address: string; data: string; topics: readonly string[] }[];
  recipient: string;
  tokenAddress: string;
}): bigint {
  const recipient = ethers.getAddress(input.recipient).toLowerCase();
  const token = ethers.getAddress(input.tokenAddress).toLowerCase();
  let total = 0n;
  for (const log of input.logs) {
    if (
      log.address.toLowerCase() !== token ||
      log.topics.length !== 3 ||
      log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()
    ) {
      continue;
    }
    try {
      const to = ethers.getAddress(`0x${log.topics[2]?.slice(-40)}`);
      if (to.toLowerCase() === recipient) total += BigInt(log.data);
    } catch {
      // Malformed and unrelated logs are not settlement evidence.
    }
  }
  return total;
}
