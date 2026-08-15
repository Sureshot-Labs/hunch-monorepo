import { ethers } from "ethers";

import type { JsonValue } from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  fetchErc20Allowance,
  fetchErc20BalanceOf,
  fetchEvmBlockHash,
  fetchEvmBlockNumber,
  fetchEvmCall,
  fetchEvmCode,
} from "../../services/polygon-rpc.js";

const pullerInterface = new ethers.Interface([
  "function pullNonce(address owner) view returns (uint256)",
  "function depositWalletOf(address owner) view returns (address)",
]);
const depositWalletInterface = new ethers.Interface([
  "function owner() view returns (address)",
]);

export type PolymarketDepositWalletPullerObservation = Readonly<{
  kind: "polymarket_deposit_wallet_puller_state_v1";
  blockNumber: string;
  blockHash: string;
  controller: string;
  depositWallet: string;
  owner: string;
  nonce: string;
  allowanceRaw: string;
  depositBalanceRaw: string;
}>;

export async function readPolymarketDepositWalletPullerState(input: {
  controller: string;
}): Promise<Readonly<Record<string, JsonValue>>> {
  const puller =
    fundingSidecarRuntimeConfig.polymarketDepositWalletPullerAddress;
  if (!puller) throw new Error("Polymarket Deposit Wallet Puller is disabled");
  const rpcUrl = fundingSidecarRuntimeConfig.polygonRpcUrl;
  const timeoutMs = fundingSidecarRuntimeConfig.polygonRpcTimeoutMs;
  const controller = ethers.getAddress(input.controller);
  const firstBlock = await fetchEvmBlockNumber({
    rpcUrl,
    timeoutMs,
    bypassCache: true,
  });
  const firstBlockNumber = Number(firstBlock);
  if (!Number.isSafeInteger(firstBlockNumber)) {
    throw new Error("Polygon block is unsafe");
  }
  const firstBlockHash = await fetchEvmBlockHash({
    rpcUrl,
    timeoutMs,
    blockNumber: firstBlockNumber,
  });
  const depositWalletRaw = await fetchEvmCall({
    rpcUrl,
    timeoutMs,
    to: puller,
    data: pullerInterface.encodeFunctionData("depositWalletOf", [controller]),
  });
  const depositWallet = ethers.getAddress(
    String(
      pullerInterface.decodeFunctionResult(
        "depositWalletOf",
        depositWalletRaw,
      )[0],
    ),
  );
  const [code, ownerRaw, nonceRaw, allowanceRaw, depositBalanceRaw] =
    await Promise.all([
      fetchEvmCode({
        rpcUrl,
        timeoutMs,
        address: depositWallet,
        bypassCache: true,
      }),
      fetchEvmCall({
        rpcUrl,
        timeoutMs,
        to: depositWallet,
        data: depositWalletInterface.encodeFunctionData("owner"),
      }),
      fetchEvmCall({
        rpcUrl,
        timeoutMs,
        to: puller,
        data: pullerInterface.encodeFunctionData("pullNonce", [controller]),
      }),
      fetchErc20Allowance({
        rpcUrl,
        timeoutMs,
        tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        owner: depositWallet,
        spender: puller,
      }),
      fetchErc20BalanceOf({
        rpcUrl,
        timeoutMs,
        tokenAddress: fundingSidecarRuntimeConfig.polymarketPusdAddress,
        owner: depositWallet,
      }),
    ]);
  const lastBlock = await fetchEvmBlockNumber({
    rpcUrl,
    timeoutMs,
    bypassCache: true,
  });
  const lastBlockNumber = Number(lastBlock);
  if (!Number.isSafeInteger(lastBlockNumber)) {
    throw new Error("Polygon block is unsafe");
  }
  const lastBlockHash = await fetchEvmBlockHash({
    rpcUrl,
    timeoutMs,
    blockNumber: lastBlockNumber,
  });
  if (
    firstBlock !== lastBlock ||
    !firstBlockHash ||
    !lastBlockHash ||
    firstBlockHash.toLowerCase() !== lastBlockHash.toLowerCase() ||
    code === "0x"
  ) {
    throw new Error("Puller state changed during the anchored read");
  }
  const owner = ethers.getAddress(
    String(depositWalletInterface.decodeFunctionResult("owner", ownerRaw)[0]),
  );
  const nonce = pullerInterface.decodeFunctionResult("pullNonce", nonceRaw)[0];
  if (typeof nonce !== "bigint") {
    throw new Error("Puller state response is incomplete");
  }
  return {
    kind: "polymarket_deposit_wallet_puller_state_v1",
    blockNumber: firstBlock.toString(),
    blockHash: lastBlockHash,
    controller,
    depositWallet,
    owner,
    nonce: nonce.toString(),
    allowanceRaw: allowanceRaw.toString(),
    depositBalanceRaw: depositBalanceRaw.toString(),
  };
}

export function parsePolymarketDepositWalletPullerObservation(
  value: Readonly<Record<string, JsonValue>> | undefined,
): PolymarketDepositWalletPullerObservation | null {
  if (
    value?.kind !== "polymarket_deposit_wallet_puller_state_v1" ||
    typeof value.blockNumber !== "string" ||
    typeof value.blockHash !== "string" ||
    typeof value.controller !== "string" ||
    typeof value.depositWallet !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.allowanceRaw !== "string" ||
    typeof value.depositBalanceRaw !== "string"
  )
    return null;
  return value as PolymarketDepositWalletPullerObservation;
}
