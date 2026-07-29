import { Interface } from "ethers";

import { fetchEvmMulticall } from "../../services/polygon-rpc.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
} from "../../services/solana-rpc.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import type { AssetRef } from "../domain/types.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

const ERC20_BALANCE_INTERFACE = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
]);

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
