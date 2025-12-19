import { abis } from "@hunch/contracts";
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
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
]);

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

const polymarketExchangeIface = new Interface(abis.IPolymarketExchange);
const feeCollectorIface = new Interface(abis.PolymarketFeeCollector);

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

export async function fetchEvmCode(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  address: string;
}): Promise<string> {
  const address = ethers.getAddress(inputs.address);
  return ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_getCode",
    params: [address, "latest"],
  });
}

export async function fetchEvmCall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  to: string;
  data: string;
}): Promise<string> {
  const to = ethers.getAddress(inputs.to);
  return ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to, data: inputs.data }, "latest"],
  });
}

export async function fetchErc20BalanceOf(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  tokenAddress: string;
  owner: string;
}): Promise<bigint> {
  const tokenAddress = ethers.getAddress(inputs.tokenAddress);
  const owner = ethers.getAddress(inputs.owner);

  const data = erc20Iface.encodeFunctionData("balanceOf", [owner]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: tokenAddress, data }, "latest"],
  });

  const decoded = erc20Iface.decodeFunctionResult(
    "balanceOf",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Polygon RPC: invalid balanceOf result");
  }
  return value;
}

export async function fetchErc20Allowance(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  tokenAddress: string;
  owner: string;
  spender: string;
}): Promise<bigint> {
  const tokenAddress = ethers.getAddress(inputs.tokenAddress);
  const owner = ethers.getAddress(inputs.owner);
  const spender = ethers.getAddress(inputs.spender);

  const data = erc20Iface.encodeFunctionData("allowance", [owner, spender]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: tokenAddress, data }, "latest"],
  });

  const decoded = erc20Iface.decodeFunctionResult(
    "allowance",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Polygon RPC: invalid allowance result");
  }
  return value;
}

export async function fetchPolymarketOrderHash(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  exchangeAddress: string;
  order: {
    salt: string | number | bigint;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string | number | bigint;
    makerAmount: string | number | bigint;
    takerAmount: string | number | bigint;
    expiration: string | number | bigint;
    nonce: string | number | bigint;
    feeRateBps: string | number | bigint;
    side: number;
    signatureType: number;
    signature: string;
  };
}): Promise<string> {
  const exchangeAddress = ethers.getAddress(inputs.exchangeAddress);
  const data = polymarketExchangeIface.encodeFunctionData("hashOrder", [
    inputs.order,
  ]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: exchangeAddress, data }, "latest"],
  });
  const decoded = polymarketExchangeIface.decodeFunctionResult(
    "hashOrder",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "string") {
    throw new Error("Polygon RPC: invalid hashOrder result");
  }
  return value;
}

export async function fetchFeeCollectorNonce(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  collectorAddress: string;
  signer: string;
}): Promise<bigint> {
  const collectorAddress = ethers.getAddress(inputs.collectorAddress);
  const signer = ethers.getAddress(inputs.signer);
  const data = feeCollectorIface.encodeFunctionData("nonces", [signer]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: collectorAddress, data }, "latest"],
  });
  const decoded = feeCollectorIface.decodeFunctionResult(
    "nonces",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "bigint") {
    throw new Error("Polygon RPC: invalid nonces result");
  }
  return value;
}

export async function fetchErc1155IsApprovedForAll(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  owner: string;
  operator: string;
}): Promise<boolean> {
  const contractAddress = ethers.getAddress(inputs.contractAddress);
  const owner = ethers.getAddress(inputs.owner);
  const operator = ethers.getAddress(inputs.operator);

  const data = erc1155Iface.encodeFunctionData("isApprovedForAll", [
    owner,
    operator,
  ]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: contractAddress, data }, "latest"],
  });

  const decoded = erc1155Iface.decodeFunctionResult(
    "isApprovedForAll",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  if (typeof value !== "boolean") {
    throw new Error("Polygon RPC: invalid isApprovedForAll result");
  }
  return value;
}
