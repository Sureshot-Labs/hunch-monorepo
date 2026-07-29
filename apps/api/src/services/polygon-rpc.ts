import {
  isAbortError,
  isRetryableHttpStatus,
  isRpcRateLimit,
  parseRetryAfterMs,
  sleep,
} from "@hunch/shared";
import { Interface, ethers } from "ethers";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import { abis } from "../lib/contracts.js";
import { isRecord } from "../lib/type-guards.js";

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcResponse<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: JsonRpcError };

function rpcErrorMessageFromBody(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
    const message = parsed.error.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : null;
  } catch {
    return null;
  }
}

export function parseEvmGetLogsBlockRangeLimit(error: unknown): bigint | null {
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /up to (?:a )?(\d+) block range/i.exec(message) ??
    /block range (?:is )?(?:limited to|maximum|max)[:\s]+(\d+)/i.exec(message);
  if (!match?.[1]) return null;
  const value = BigInt(match[1]);
  return value > 0n ? value : null;
}

const erc1155Iface = new Interface([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
]);

const erc20Iface = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

const polymarketExchangeIface = new Interface(abis.IPolymarketExchange);
const polymarketExchangeV2Iface = new Interface(abis.IPolymarketExchangeV2);
const feeCollectorIface = new Interface(abis.PolymarketFeeCollector);
const multicallIface = new Interface([
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
]);

const CODE_CACHE_TTL_MS = fundingSidecarRuntimeConfig.evmCodeCacheTtlMs;
const APPROVAL_CACHE_TTL_MS = fundingSidecarRuntimeConfig.evmApprovalCacheTtlMs;
const BLOCK_NUMBER_CACHE_TTL_MS = 1_000;

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
    if (ttlMs <= 0) return loader();
    if (options?.bypass) {
      const value = await loader();
      set(key, value);
      return value;
    }
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
const blockNumberCache = createTimedCache<bigint>(BLOCK_NUMBER_CACHE_TTL_MS);
const rpcReadInflight = new Map<string, Promise<unknown>>();

function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
): number {
  if (
    retryAfterMs != null &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
  ) {
    return Math.min(
      retryAfterMs,
      Math.max(
        fundingSidecarRuntimeConfig.walletIntelRetryBaseBackoffMs,
        fundingSidecarRuntimeConfig.walletIntelRetryMaxBackoffMs,
      ),
    );
  }
  const exponential =
    fundingSidecarRuntimeConfig.walletIntelRetryBaseBackoffMs *
    Math.max(1, 2 ** Math.max(0, attempt));
  return Math.min(
    exponential,
    fundingSidecarRuntimeConfig.walletIntelRetryMaxBackoffMs,
  );
}

async function executeEthRpcRequest<T>(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  let lastError: unknown = null;
  const maxAttempts = Math.max(
    1,
    fundingSidecarRuntimeConfig.walletIntelRetryMaxAttempts,
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        const responseBody = await response.text().catch(() => "");
        const providerMessage = rpcErrorMessageFromBody(responseBody);
        const error = new Error(
          [
            `Polygon RPC error: ${response.status} ${response.statusText}`,
            providerMessage,
          ]
            .filter(Boolean)
            .join(": "),
        );
        lastError = error;
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        const retryable =
          attempt < maxAttempts - 1 && isRetryableHttpStatus(response.status);
        if (retryable) {
          await sleep(computeBackoffMs(attempt, retryAfterMs));
          continue;
        }
        throw error;
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
        const error = new Error(
          `Polygon RPC ${inputs.method} error: ${message}`,
        );
        lastError = error;
        const retryable = attempt < maxAttempts - 1 && isRpcRateLimit(error);
        if (retryable) {
          await sleep(computeBackoffMs(attempt, null));
          continue;
        }
        throw error;
      }

      return rpc.result;
    } catch (error) {
      lastError = error;
      const retryable =
        attempt < maxAttempts - 1 &&
        (isAbortError(error) || isRpcRateLimit(error));
      if (retryable) {
        await sleep(computeBackoffMs(attempt, null));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error(`Polygon RPC ${inputs.method} failed`);
}

async function ethRpcRequest<T>(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  method: string;
  params: unknown[];
}): Promise<T> {
  const key = JSON.stringify([
    inputs.rpcUrl,
    inputs.timeoutMs,
    inputs.method,
    inputs.params,
  ]);
  const pending = rpcReadInflight.get(key);
  if (pending) return pending as Promise<T>;

  const request = executeEthRpcRequest<T>(inputs).finally(() => {
    rpcReadInflight.delete(key);
  });
  rpcReadInflight.set(key, request);
  return request;
}

export type EvmErc20TransferLog = Readonly<{
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  rawAmount: bigint;
}>;

type EvmRpcLog = Readonly<{
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed?: boolean;
}>;

const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function rpcQuantity(value: bigint): string {
  if (value < 0n) throw new Error("EVM RPC quantity cannot be negative");
  return `0x${value.toString(16)}`;
}

function parseRpcQuantity(value: string, field: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`EVM RPC ${field} is invalid`);
  }
  return BigInt(value);
}

function addressTopic(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32).toLowerCase();
}

export async function fetchEvmBlockNumber(inputs: {
  rpcUrl: string;
  timeoutMs: number;
}): Promise<bigint> {
  return blockNumberCache.load(inputs.rpcUrl, async () => {
    const result = await ethRpcRequest<string>({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      method: "eth_blockNumber",
      params: [],
    });
    return parseRpcQuantity(result, "block number");
  });
}

export async function fetchErc20TransferLogs(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  recipientAddress: string;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<readonly EvmErc20TransferLog[]> {
  if (inputs.toBlock < inputs.fromBlock) return [];
  const contractAddress = ethers.getAddress(inputs.contractAddress);
  const recipientAddress = ethers.getAddress(inputs.recipientAddress);
  const logs = await ethRpcRequest<readonly EvmRpcLog[]>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_getLogs",
    params: [
      {
        address: contractAddress,
        fromBlock: rpcQuantity(inputs.fromBlock),
        toBlock: rpcQuantity(inputs.toBlock),
        topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(recipientAddress)],
      },
    ],
  });
  const transferInterface = new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  return logs.flatMap((log): EvmErc20TransferLog[] => {
    if (log.removed) return [];
    if (
      log.address.toLowerCase() !== contractAddress.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()
    ) {
      return [];
    }
    const decoded = transferInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!decoded) return [];
    const from = decoded.args.from;
    const to = decoded.args.to;
    const value = decoded.args.value;
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      typeof value !== "bigint" ||
      to.toLowerCase() !== recipientAddress.toLowerCase()
    ) {
      return [];
    }
    const logIndex = parseRpcQuantity(log.logIndex, "log index");
    if (logIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("EVM RPC log index exceeds the safe integer range");
    }
    return [
      {
        transactionHash: log.transactionHash.toLowerCase(),
        logIndex: Number(logIndex),
        blockNumber: parseRpcQuantity(log.blockNumber, "block number"),
        blockHash: log.blockHash.toLowerCase(),
        fromAddress: ethers.getAddress(from),
        toAddress: ethers.getAddress(to),
        rawAmount: value,
      },
    ];
  });
}

async function fetchErc1155BalanceBatch(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  pairs: readonly Readonly<{ owner: string; tokenId: string }>[];
  onRpcCall?: (() => void) | null;
}): Promise<readonly (bigint | null)[]> {
  const data = erc1155Iface.encodeFunctionData("balanceOfBatch", [
    inputs.pairs.map((pair) => pair.owner),
    inputs.pairs.map((pair) => BigInt(pair.tokenId)),
  ]);
  inputs.onRpcCall?.();
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: inputs.contractAddress, data }, "latest"],
  });
  const decoded = erc1155Iface.decodeFunctionResult(
    "balanceOfBatch",
    result,
  ) as unknown;
  const balances = Array.isArray(decoded) ? decoded[0] : null;
  if (!Array.isArray(balances)) {
    throw new Error("Polygon RPC: invalid balanceOfBatch result");
  }
  return inputs.pairs.map((_, index) => {
    const raw = balances[index] as unknown;
    return typeof raw === "bigint" ? raw : null;
  });
}

type Erc1155OwnedTokenPair = Readonly<{
  owner: string;
  ownerKey: string;
  tokenId: string;
}>;

function mergeErc1155BalanceBatch(
  output: Map<string, Map<string, bigint>>,
  pairs: readonly Erc1155OwnedTokenPair[],
  balances: readonly (bigint | null)[],
): void {
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const value = balances[index] ?? null;
    if (!pair || value == null) continue;
    const ownerBalances = output.get(pair.ownerKey) ?? new Map();
    ownerBalances.set(pair.tokenId, value);
    output.set(pair.ownerKey, ownerBalances);
  }
}

async function fetchErc1155OwnedTokenPairBalances(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  pairs: readonly Erc1155OwnedTokenPair[];
  maxPairsPerCall?: number;
  onRpcCall?: (() => void) | null;
}): Promise<Map<string, Map<string, bigint>>> {
  const contractAddress = ethers.getAddress(inputs.contractAddress);
  const maxPairsPerCall = Math.max(
    1,
    Math.trunc(inputs.maxPairsPerCall ?? 1000),
  );
  const output = new Map<string, Map<string, bigint>>();
  for (let i = 0; i < inputs.pairs.length; i += maxPairsPerCall) {
    const chunk = inputs.pairs.slice(i, i + maxPairsPerCall);
    const balances = await fetchErc1155BalanceBatch({
      rpcUrl: inputs.rpcUrl,
      timeoutMs: inputs.timeoutMs,
      contractAddress,
      pairs: chunk,
      onRpcCall: inputs.onRpcCall,
    });
    mergeErc1155BalanceBatch(output, chunk, balances);
  }
  return output;
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

  const balances = await fetchErc1155BalanceBatch({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    contractAddress,
    pairs: inputs.tokenIds.map((tokenId) => ({ owner, tokenId })),
  });

  const output = new Map<string, bigint>();
  for (let i = 0; i < inputs.tokenIds.length; i += 1) {
    const tokenId = inputs.tokenIds[i];
    const value = balances[i] ?? null;
    if (!tokenId || value == null) continue;
    output.set(tokenId, value);
  }

  return output;
}

export async function fetchErc1155BalancesByOwners(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  owners: string[];
  tokenIds: string[];
  maxPairsPerCall?: number;
  onRpcCall?: (() => void) | null;
}): Promise<Map<string, Map<string, bigint>>> {
  const owners = Array.from(
    new Map(
      inputs.owners.map((owner) => {
        const checksummed = ethers.getAddress(owner);
        return [checksummed.toLowerCase(), checksummed];
      }),
    ).values(),
  );
  const tokenIds = Array.from(
    new Set(
      inputs.tokenIds
        .map((tokenId) => tokenId.trim())
        .filter((tokenId) => /^[0-9]+$/.test(tokenId)),
    ),
  );
  if (owners.length === 0 || tokenIds.length === 0) return new Map();

  const pairs: Erc1155OwnedTokenPair[] = [];
  for (const owner of owners) {
    const ownerKey = owner.toLowerCase();
    for (const tokenId of tokenIds) {
      pairs.push({ owner, ownerKey, tokenId });
    }
  }

  return fetchErc1155OwnedTokenPairBalances({
    ...inputs,
    pairs,
  });
}

export async function fetchErc1155BalancesForOwnerTokenPairs(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  contractAddress: string;
  pairs: Array<{ owner: string; tokenId: string }>;
  maxPairsPerCall?: number;
  onRpcCall?: (() => void) | null;
}): Promise<Map<string, Map<string, bigint>>> {
  const pairs = Array.from(
    new Map(
      inputs.pairs.flatMap((pair) => {
        let owner: string;
        try {
          owner = ethers.getAddress(pair.owner);
        } catch {
          return [];
        }
        if (owner === ethers.ZeroAddress) return [];
        const tokenId = pair.tokenId.trim();
        if (!/^[0-9]+$/.test(tokenId)) return [];
        const key = `${owner.toLowerCase()}:${tokenId}`;
        return [[key, { owner, ownerKey: owner.toLowerCase(), tokenId }]];
      }),
    ).values(),
  );
  if (pairs.length === 0) return new Map();

  return fetchErc1155OwnedTokenPairBalances({
    ...inputs,
    pairs,
  });
}

export async function fetchEvmCode(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  address: string;
  bypassCache?: boolean;
}): Promise<string> {
  const address = ethers.getAddress(inputs.address);
  const cacheKey = `${inputs.rpcUrl}:${address}`.toLowerCase();
  return codeCache.load(
    cacheKey,
    () =>
      ethRpcRequest<string>({
        rpcUrl: inputs.rpcUrl,
        timeoutMs: inputs.timeoutMs,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    { bypass: inputs.bypassCache },
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

export async function fetchPolymarketOrderStatus(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  exchangeAddress: string;
  orderHash: string;
}): Promise<{ isFilledOrCancelled: boolean; remaining: bigint }> {
  const exchangeAddress = ethers.getAddress(inputs.exchangeAddress);
  const data = polymarketExchangeIface.encodeFunctionData("getOrderStatus", [
    inputs.orderHash,
  ]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: exchangeAddress, data }, "latest"],
  });
  const decoded = polymarketExchangeIface.decodeFunctionResult(
    "getOrderStatus",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  const record =
    value && typeof value === "object"
      ? (value as {
          0?: boolean;
          1?: bigint;
          isFilledOrCancelled?: boolean;
          remaining?: bigint;
        })
      : null;
  const isFilledOrCancelled =
    typeof record?.isFilledOrCancelled === "boolean"
      ? record.isFilledOrCancelled
      : typeof record?.[0] === "boolean"
        ? record[0]
        : null;
  const remaining =
    typeof record?.remaining === "bigint"
      ? record.remaining
      : typeof record?.[1] === "bigint"
        ? record[1]
        : null;
  if (isFilledOrCancelled == null || remaining == null) {
    throw new Error("Polygon RPC: invalid getOrderStatus result");
  }
  return {
    isFilledOrCancelled,
    remaining,
  };
}

export async function fetchPolymarketOrderStatusV2(inputs: {
  rpcUrl: string;
  timeoutMs: number;
  exchangeAddress: string;
  orderHash: string;
}): Promise<{ filled: boolean; remaining: bigint }> {
  const exchangeAddress = ethers.getAddress(inputs.exchangeAddress);
  const data = polymarketExchangeV2Iface.encodeFunctionData("getOrderStatus", [
    inputs.orderHash,
  ]);
  const result = await ethRpcRequest<string>({
    rpcUrl: inputs.rpcUrl,
    timeoutMs: inputs.timeoutMs,
    method: "eth_call",
    params: [{ to: exchangeAddress, data }, "latest"],
  });
  const decoded = polymarketExchangeV2Iface.decodeFunctionResult(
    "getOrderStatus",
    result,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  const record =
    value && typeof value === "object"
      ? (value as {
          0?: boolean;
          1?: bigint;
          filled?: boolean;
          remaining?: bigint;
        })
      : null;
  const filled =
    typeof record?.filled === "boolean"
      ? record.filled
      : typeof record?.[0] === "boolean"
        ? record[0]
        : null;
  const remaining =
    typeof record?.remaining === "bigint"
      ? record.remaining
      : typeof record?.[1] === "bigint"
        ? record[1]
        : null;
  if (filled == null || remaining == null) {
    throw new Error("Polygon RPC: invalid V2 getOrderStatus result");
  }
  return {
    filled,
    remaining,
  };
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
  const cacheKey =
    `${inputs.rpcUrl}:${contractAddress}:${owner}:${operator}`.toLowerCase();
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
