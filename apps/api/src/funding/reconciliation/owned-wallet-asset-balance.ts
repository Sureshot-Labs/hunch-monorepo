import { getAddress, Interface, ZeroAddress } from "ethers";

import {
  fetchEvmBlockHash,
  fetchErc20TransferLogs,
  fetchEvmMulticall,
} from "../../services/polygon-rpc.js";
import {
  fetchSolanaBalanceLamports,
  fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot,
  fetchFinalizedSolanaOwnedTokenDebit,
  fetchSolanaTokenBalanceByOwnerAndMint,
} from "../../services/solana-rpc.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import type { AssetRef } from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

const ERC20_BALANCE_INTERFACE = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);

type FinalizedEvmReceiveSourceEvent = Readonly<{
  sourceLedgerHeight: string;
  txHash: string;
  eventIndex: string;
  blockHash: string;
  sourceAddress: string | null;
  sourceRaw: string;
}>;

async function finalizedEvmRpc<T>(
  input: Readonly<{
    rpcUrl: string;
    timeoutMs: number;
    method: string;
    params: readonly unknown[];
  }>,
): Promise<T> {
  const response = await fetch(input.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: input.method,
      params: input.params,
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error("finalized EVM balance RPC unavailable");
  const payload = (await response.json()) as { result?: T; error?: unknown };
  if (payload.error || payload.result == null) {
    throw new Error("finalized EVM balance RPC returned no result");
  }
  return payload.result;
}

/** Finalized EVM source inventory, anchored to one block and checked for reorgs. */
export async function fetchFinalizedEvmOwnedAssetBalanceAfterBlock(
  input: Readonly<{
    rpcUrl: string;
    timeoutMs: number;
    expectedChainId: 137 | 8453;
    owner: string;
    token: string;
    minimumBlock: string;
    sourceEvent?: FinalizedEvmReceiveSourceEvent;
  }>,
): Promise<Readonly<{ raw: string; block: string }>> {
  if (!/^[0-9]+$/.test(input.minimumBlock)) {
    throw new Error("receive source balance block is invalid");
  }
  // Receive identities accept any 40-hex spelling, not only valid EIP-55
  // mixed case. Normalize before ethers validates the address shape.
  const owner = getAddress(input.owner.toLowerCase());
  const token = getAddress(input.token.toLowerCase());
  const chainId = await finalizedEvmRpc<unknown>({
    rpcUrl: input.rpcUrl,
    timeoutMs: input.timeoutMs,
    method: "eth_chainId",
    params: [],
  });
  if (
    typeof chainId !== "string" ||
    !/^0x[0-9a-f]+$/i.test(chainId) ||
    BigInt(chainId) !== BigInt(input.expectedChainId)
  ) {
    throw new Error("finalized EVM balance RPC network mismatch");
  }
  const finalized = await finalizedEvmRpc<unknown>({
    rpcUrl: input.rpcUrl,
    timeoutMs: input.timeoutMs,
    method: "eth_getBlockByNumber",
    params: ["finalized", false],
  });
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized)) {
    throw new Error("finalized EVM block is invalid");
  }
  const block = finalized as Record<string, unknown>;
  if (
    typeof block.number !== "string" ||
    !/^0x[0-9a-f]+$/i.test(block.number) ||
    typeof block.hash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(block.hash)
  ) {
    throw new Error("finalized EVM block identity is invalid");
  }
  const blockNumber = BigInt(block.number);
  if (
    blockNumber < BigInt(input.minimumBlock) ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("finalized EVM block predates a known source credit");
  }
  if (input.sourceEvent) {
    const sourceEvent = input.sourceEvent;
    if (
      token === ZeroAddress ||
      !/^(0|[1-9][0-9]*)$/.test(sourceEvent.sourceLedgerHeight) ||
      !/^(0|[1-9][0-9]*)$/.test(sourceEvent.eventIndex) ||
      !/^[1-9][0-9]*$/.test(sourceEvent.sourceRaw) ||
      !/^0x[0-9a-f]{64}$/i.test(sourceEvent.txHash) ||
      !/^0x[0-9a-f]{64}$/i.test(sourceEvent.blockHash)
    ) {
      throw new Error("receive source event identity is invalid");
    }
    const sourceBlock = BigInt(sourceEvent.sourceLedgerHeight);
    const logIndex = BigInt(sourceEvent.eventIndex);
    if (
      sourceBlock > blockNumber ||
      sourceBlock > BigInt(Number.MAX_SAFE_INTEGER) ||
      logIndex > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("receive source event is not finalized");
    }
    const canonicalSourceHash = await fetchEvmBlockHash({
      rpcUrl: input.rpcUrl,
      timeoutMs: input.timeoutMs,
      blockNumber: Number(sourceBlock),
    });
    if (
      canonicalSourceHash?.toLowerCase() !== sourceEvent.blockHash.toLowerCase()
    ) {
      throw new Error("receive source event block is not canonical");
    }
    const logs = await fetchErc20TransferLogs({
      rpcUrl: input.rpcUrl,
      timeoutMs: input.timeoutMs,
      contractAddress: token,
      recipientAddress: owner,
      fromBlock: sourceBlock,
      toBlock: sourceBlock,
    });
    const sourceAddress = sourceEvent.sourceAddress
      ? getAddress(sourceEvent.sourceAddress.toLowerCase())
      : null;
    if (
      !logs.some(
        (log) =>
          log.transactionHash.toLowerCase() ===
            sourceEvent.txHash.toLowerCase() &&
          BigInt(log.logIndex) === logIndex &&
          log.blockNumber === sourceBlock &&
          log.blockHash.toLowerCase() === sourceEvent.blockHash.toLowerCase() &&
          log.rawAmount === BigInt(sourceEvent.sourceRaw) &&
          (sourceAddress === null || log.fromAddress === sourceAddress),
      )
    ) {
      throw new Error("receive source transfer is not canonical");
    }
  }
  const balanceResult =
    token === ZeroAddress
      ? await finalizedEvmRpc<unknown>({
          rpcUrl: input.rpcUrl,
          timeoutMs: input.timeoutMs,
          method: "eth_getBalance",
          params: [owner, block.number],
        })
      : await finalizedEvmRpc<unknown>({
          rpcUrl: input.rpcUrl,
          timeoutMs: input.timeoutMs,
          method: "eth_call",
          params: [
            {
              to: token,
              data: ERC20_BALANCE_INTERFACE.encodeFunctionData("balanceOf", [
                owner,
              ]),
            },
            block.number,
          ],
        });
  if (typeof balanceResult !== "string") {
    throw new Error("finalized EVM source balance is invalid");
  }
  const observedHash = await fetchEvmBlockHash({
    rpcUrl: input.rpcUrl,
    timeoutMs: input.timeoutMs,
    blockNumber: Number(blockNumber),
  });
  if (observedHash?.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error("finalized EVM balance block changed during observation");
  }
  const raw =
    token === ZeroAddress
      ? (() => {
          if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(balanceResult)) {
            throw new Error("finalized EVM native balance is invalid");
          }
          return BigInt(balanceResult).toString();
        })()
      : BigInt(
          ERC20_BALANCE_INTERFACE.decodeFunctionResult(
            "balanceOf",
            balanceResult,
          )[0],
        ).toString();
  return { raw, block: blockNumber.toString() };
}

export async function observeFinalizedOwnedReceiveSourceBalance(
  input: Readonly<{
    asset: AssetRef;
    destinationAddress: string;
    minimumHeight: string;
    sourceEvent: FinalizedEvmReceiveSourceEvent;
  }>,
): Promise<Readonly<{ raw: string; height: string }>> {
  if (input.asset.networkId === "solana:mainnet") {
    const observed = await observeFinalizedSolanaOwnedAssetBalanceAfterSlot({
      asset: input.asset,
      destinationAddress: input.destinationAddress,
      minimumSlot: input.minimumHeight,
    });
    return { raw: observed.raw, height: observed.slot };
  }
  const rpc =
    input.asset.networkId === "evm:137"
      ? {
          rpcUrl: fundingSidecarRuntimeConfig.polygonRpcUrl,
          timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
          expectedChainId: 137 as const,
        }
      : input.asset.networkId === "evm:8453"
        ? {
            rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
            timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
            expectedChainId: 8453 as const,
          }
        : null;
  if (!rpc) throw new Error("receive source network is not supported");
  const observed = await fetchFinalizedEvmOwnedAssetBalanceAfterBlock({
    ...rpc,
    owner: input.destinationAddress,
    token: input.asset.assetId,
    minimumBlock: input.minimumHeight,
    sourceEvent: input.sourceEvent,
  });
  return { raw: observed.raw, height: observed.block };
}

export async function observeFinalizedSolanaOwnedAssetBalanceAfterSlot(
  input: Readonly<{
    asset: AssetRef;
    destinationAddress: string;
    minimumSlot: string;
  }>,
): Promise<Readonly<{ raw: string; slot: string }>> {
  const slot = Number(input.minimumSlot);
  if (!/^[0-9]+$/.test(input.minimumSlot) || !Number.isSafeInteger(slot)) {
    throw new Error("receive source balance slot is invalid");
  }
  const native =
    input.asset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
    input.asset.decimals === 9;
  const observed = await fetchFinalizedSolanaOwnedBalanceAtOrAfterSlot({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    owner: input.destinationAddress,
    mint: native ? null : input.asset.assetId,
    decimals: input.asset.decimals,
    minimumSlot: slot,
    timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
  });
  return { raw: observed.amount.toString(), slot: observed.slot.toString() };
}

export async function verifyFinalizedSolanaReceiveSourceDebit(
  input: Readonly<{
    signature: string;
    destinationAddress: string;
    asset: AssetRef;
    expectedRaw: string;
    expectedSlot: string;
  }>,
): Promise<boolean> {
  if (
    input.asset.networkId !== "solana:mainnet" ||
    input.asset.assetId === RELAY_PINNED_ASSETS.solanaNative ||
    !/^[1-9][0-9]*$/.test(input.expectedRaw) ||
    !/^[1-9][0-9]*$/.test(input.expectedSlot)
  )
    return false;
  const debit = await fetchFinalizedSolanaOwnedTokenDebit({
    rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
    signature: input.signature,
    owner: input.destinationAddress,
    mint: input.asset.assetId,
    decimals: input.asset.decimals,
    timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
  });
  return debit?.raw === input.expectedRaw && debit.slot === input.expectedSlot;
}

export async function observeOwnedWalletAssetBalance(
  input: Readonly<{
    networkId: string;
    asset: AssetRef;
    destinationAddress: string;
  }>,
): Promise<string> {
  if (input.networkId === "solana:mainnet") {
    if (
      input.asset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
      input.asset.decimals === 9
    ) {
      return (
        await fetchSolanaBalanceLamports({
          rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
          owner: input.destinationAddress,
          timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
        })
      ).toString();
    }
    const balance = await fetchSolanaTokenBalanceByOwnerAndMint({
      rpcUrls: [...fundingSidecarRuntimeConfig.solanaRpcUrls],
      owner: input.destinationAddress,
      mint: input.asset.assetId,
      timeoutMs: fundingSidecarRuntimeConfig.solanaRpcTimeoutMs,
    });
    return (balance?.amount ?? 0n).toString();
  }

  const rpc =
    input.networkId === "evm:137"
      ? {
          url: fundingSidecarRuntimeConfig.polygonRpcUrl,
          timeoutMs: fundingSidecarRuntimeConfig.polygonRpcTimeoutMs,
          multicallAddress: fundingSidecarRuntimeConfig.polygonMulticallAddress,
        }
      : input.networkId === "evm:8453"
        ? {
            url: fundingSidecarRuntimeConfig.baseRpcUrl,
            timeoutMs: fundingSidecarRuntimeConfig.baseRpcTimeoutMs,
            multicallAddress: fundingSidecarRuntimeConfig.baseMulticallAddress,
          }
        : null;
  if (!rpc)
    throw new Error("owned wallet observation network is not supported");

  const [result] = await fetchEvmMulticall({
    rpcUrl: rpc.url,
    timeoutMs: rpc.timeoutMs,
    multicallAddress: rpc.multicallAddress,
    calls: [
      {
        target: input.asset.assetId,
        callData: ERC20_BALANCE_INTERFACE.encodeFunctionData("balanceOf", [
          input.destinationAddress,
        ]),
        allowFailure: false,
      },
    ],
  });
  if (!result?.success) {
    throw new Error("owned wallet ERC-20 balance observation failed");
  }
  const decoded = ERC20_BALANCE_INTERFACE.decodeFunctionResult(
    "balanceOf",
    result.returnData,
  );
  const raw = decoded[0];
  if (typeof raw !== "bigint") {
    throw new Error("owned wallet ERC-20 balance observation is invalid");
  }
  return raw.toString();
}
