import { abis } from "@hunch/contracts";
import { Interface, ethers } from "ethers";
import { env } from "../env.js";
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
const multicallIface = new Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
]);

const CODE_CACHE_TTL_MS = env.evmCodeCacheTtlMs;
const APPROVAL_CACHE_TTL_MS = env.evmApprovalCacheTtlMs;

type CacheEntry<T> = { value: T; expiresAt: number };

function createTimedCache<T>(ttlMs: number) {
  const store = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function get(key: string): T | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  function set(key: string, value: T) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async function load(
    key: string,
    loader: () => Promise<T>,
    options?: { bypass?: boolean },
  ): Promise<T> {
    if (ttlMs <= 0 || options?.bypass) return loader();
    const cached = get(key);
    if (cached != null) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = loader()
      .then((value) => {
        set(key, value);
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  return { load };
}

const codeCache = createTimedCache<string>(CODE_CACHE_TTL_MS);
const approvalCache = createTimedCache<boolean>(APPROVAL_CACHE_TTL_MS);

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
  const cacheKey = `${inputs.rpcUrl}:${address}`.toLowerCase();
  return codeCache.load(cacheKey, () =>
    ethRpcRequest<string>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      method: "eth_getCode",
      params: [address, "latest"],
    }),
  );
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

export async function fetchEvmBalance(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  address: string;
}): Promise<bigint> {
  const address = ethers.getAddress(inputs.address);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_getBalance",
    params: [address, "latest"],
  });
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new Error("Polygon RPC: invalid getBalance result");
  }
  return BigInt(result);
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
  bypassCache?: boolean;
}): Promise<boolean> {
  const contractAddress = ethers.getAddress(inputs.contractAddress);
  const owner = ethers.getAddress(inputs.owner);
  const operator = ethers.getAddress(inputs.operator);
  const cacheKey = `${inputs.rpcUrl}:${contractAddress}:${owner}:${operator}`.toLowerCase();
  return approvalCache.load(
    cacheKey,
    async () => {
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
    },
    { bypass: inputs.bypassCache === true },
  );
}

export async function fetchEvmMulticall(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  multicallAddress: string;
  calls: Array<{ target: string; callData: string; allowFailure?: boolean }>;
}): Promise<Array<{ success: boolean; returnData: string }>> {
  if (inputs.calls.length === 0) return [];

  const multicallAddress = ethers.getAddress(inputs.multicallAddress);
  const normalizedCalls = inputs.calls.map((call) => ({
    target: ethers.getAddress(call.target),
    allowFailure: call.allowFailure ?? true,
    callData: call.callData,
  }));

  const data = multicallIface.encodeFunctionData("aggregate3", [
    normalizedCalls,
  ]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: multicallAddress, data }, "latest"],
  });

  const decoded = multicallIface.decodeFunctionResult(
    "aggregate3",
    result,
  ) as unknown;
  const rows = Array.isArray(decoded) ? decoded[0] : null;
  if (!Array.isArray(rows)) {
    throw new Error("Polygon RPC: invalid multicall result");
  }

  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return { success: false, returnData: "0x" };
    }
    const entry = row as { success?: unknown; returnData?: unknown };
    return {
      success: entry.success === true,
      returnData:
        typeof entry.returnData === "string" ? entry.returnData : "0x",
    };
  });
}
