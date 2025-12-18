import { Interface, ethers } from "ethers";
import { isRecord } from "../lib/type-guards.js";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcError };

const erc1155Iface = new Interface([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);

async function ethRpcRequest<T>(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);

  try {
    const response = await fetch(inputs.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: inputs.method,
        params: inputs.params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Polygon RPC error: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as unknown;
    if (!isRecord(json)) {
      throw new Error("Polygon RPC: invalid JSON response");
    }

    const rpc = json as JsonRpcResponse<T>;
    if ("error" in rpc) {
      const message =
        typeof rpc.error.message === "string"
          ? rpc.error.message
          : "Unknown Polygon RPC error";
      throw new Error(`Polygon RPC ${inputs.method} error: ${message}`);
    }

    return rpc.result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchErc1155BalancesByOwner(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  owner: string;
  tokenIds: string[];
}): Promise<Map<string, bigint>> {
  if (inputs.tokenIds.length === 0) return new Map();

  const contractAddress = ethers.getAddress(inputs.contractAddress);
  const owner = ethers.getAddress(inputs.owner);

  const owners = inputs.tokenIds.map(() => owner);
  const ids = inputs.tokenIds.map((id) => BigInt(id));

  const data = erc1155Iface.encodeFunctionData("balanceOfBatch", [owners, ids]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: contractAddress, data }, "latest"],
  });

  const decoded = erc1155Iface.decodeFunctionResult(
    "balanceOfBatch",
    result,
  ) as unknown;
  const balances = Array.isArray(decoded) ? decoded[0] : null;
  if (!Array.isArray(balances)) {
    throw new Error("Polygon RPC: invalid balanceOfBatch result");
  }

  const output = new Map<string, bigint>();
  for (let i = 0; i < inputs.tokenIds.length; i += 1) {
    const tokenId = inputs.tokenIds[i];
    const raw = balances[i] as unknown;
    const value = typeof raw === "bigint" ? raw : null;
    if (!tokenId || value == null) continue;
    output.set(tokenId, value);
  }

  return output;
}
