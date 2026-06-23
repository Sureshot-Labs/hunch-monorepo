import { Interface, ethers } from "ethers";
import { chunkArray } from "@hunch/shared";

import { env } from "../env.js";
import {
  fetchEvmBalance,
  fetchEvmCode,
  fetchEvmMulticall,
} from "./polygon-rpc.js";
import { inspectSafeWalletStrict } from "./polymarket-funder.js";
import { POLYGON_NATIVE_USDC_ADDRESS } from "./polymarket-onchain.js";
import {
  fetchSolanaBalanceLamports,
  fetchSolanaTokenBalanceByOwnerAndMint,
  formatUiAmount,
} from "./solana-rpc.js";

export type WalletIntelChain = "polygon" | "base" | "solana";

export type PolymarketWalletKind =
  | "eoa"
  | "safe"
  | "polymarket_deposit_wallet"
  | "polymarket_magic_proxy"
  | "contract_unknown";

export type WalletOwnerSource =
  | "safe_getOwners"
  | "deposit_runtime_tail"
  | null;

export type WalletOwnerConfidence = "high" | "medium" | "low" | null;

export type WalletIdentityInspection = {
  walletKind: PolymarketWalletKind;
  ownerAddress: string | null;
  ownerSource: WalletOwnerSource;
  ownerConfidence: WalletOwnerConfidence;
  safeOwners: string[] | null;
  safeThreshold: number | null;
};

export type WalletOnchainBalanceEntry = {
  chain: WalletIntelChain;
  symbol: string;
  tokenAddress: string | null;
  decimals: number;
  raw: string;
  amount: string;
  isNative: boolean;
};

export type WalletOnchainBalances = Record<string, WalletOnchainBalanceEntry>;
export type WalletOnchainStateVenue = "polymarket" | "limitless" | "kalshi";
export type WalletOnchainStateVenueQuotas = Record<
  WalletOnchainStateVenue,
  number
>;

type BalanceWalletInput = {
  address: string;
  chain: WalletIntelChain;
};

type WalletLiquidBalanceFetcher = (
  wallets: BalanceWalletInput[],
) => Promise<Map<string, WalletOnchainBalances>>;

export type WalletLiquidBalanceFetchers = Partial<
  Record<WalletIntelChain, WalletLiquidBalanceFetcher>
>;
export type WalletLiquidBalanceFetchError = {
  chain: WalletIntelChain;
  error: unknown;
};
export type WalletLiquidBalanceFetchResult = {
  balances: Map<string, WalletOnchainBalances>;
  errors: WalletLiquidBalanceFetchError[];
};

const ERC20_IFACE = new Interface([
  "function balanceOf(address) view returns (uint256)",
]);
const MULTICALL3_IFACE = new Interface([
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);

const POLYGON_MULTICALL_ADDRESS =
  env.polygonMulticallAddress?.trim() ||
  "0xca11bde05977b3631167028862be2a173976ca11";
const BASE_MULTICALL_ADDRESS =
  env.baseMulticallAddress?.trim() ||
  "0xca11bde05977b3631167028862be2a173976ca11";
const EVM_NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE_ADDRESS = "11111111111111111111111111111111";
const MAGIC_PROXY_RUNTIME_PREFIX = "0x363d3d373d3d3d363d73";
const MAGIC_PROXY_RUNTIME_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const POLYMARKET_DEPOSIT_RUNTIME_PREFIX =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af4";
const POLYMARKET_DEPOSIT_RUNTIME_BYTES = 125;
const WALLET_ONCHAIN_STATE_VENUES: WalletOnchainStateVenue[] = [
  "polymarket",
  "limitless",
  "kalshi",
];

type EvmChainBalanceConfig = {
  chain: Extract<WalletIntelChain, "polygon" | "base">;
  rpcUrl: string;
  timeoutMs: number;
  multicallAddress: string;
  native: {
    key: string;
    symbol: string;
    tokenAddress: string;
    decimals: number;
  };
  tokens: Array<{
    key: string;
    symbol: string;
    tokenAddress: string;
    decimals: number;
  }>;
};

type EvmNativeBalanceFetchers = {
  batch?: (addresses: string[]) => Promise<Map<string, bigint>>;
  single?: (address: string) => Promise<bigint>;
};

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const normalized = ethers.getAddress(value).toLowerCase();
    return normalized === ethers.ZeroAddress.toLowerCase() ? null : normalized;
  } catch {
    return null;
  }
}

function normalizeBalanceWalletInput(
  wallet: BalanceWalletInput,
): BalanceWalletInput | null {
  if (wallet.chain === "solana") {
    const address = wallet.address.trim();
    return address.length > 0 ? { address, chain: wallet.chain } : null;
  }
  const address = normalizeEvmAddress(wallet.address);
  return address ? { address, chain: wallet.chain } : null;
}

function walletBalanceMapKey(chain: WalletIntelChain, address: string): string {
  return chain === "solana"
    ? `${chain}:${address.trim()}`
    : `${chain}:${address.toLowerCase()}`;
}

function normalizeHexCode(value: string | null | undefined): string {
  if (!value) return "0x";
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function isEmptyRuntime(code: string | null | undefined): boolean {
  const normalized = normalizeHexCode(code);
  return normalized === "0x" || normalized === "0x0";
}

function formatEvmBalanceEntry(input: {
  chain: Extract<WalletIntelChain, "polygon" | "base">;
  symbol: string;
  tokenAddress: string | null;
  decimals: number;
  raw: bigint;
  isNative: boolean;
}): WalletOnchainBalanceEntry {
  return {
    chain: input.chain,
    symbol: input.symbol,
    tokenAddress: input.tokenAddress,
    decimals: input.decimals,
    raw: input.raw.toString(),
    amount: ethers.formatUnits(input.raw, input.decimals),
    isNative: input.isNative,
  };
}

function decimalFromUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const padded = abs.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const value = fraction.length ? `${whole}.${fraction}` : whole;
  return negative ? `-${value}` : value;
}

export function resolveUsdLikeBalance(
  balances: WalletOnchainBalances | null | undefined,
): string | null {
  if (!balances) return null;
  let total = 0n;
  let found = false;
  for (const key of ["pusd", "usdce", "usdc"]) {
    const entry = balances[key];
    if (!entry || entry.decimals !== 6) continue;
    try {
      total += BigInt(entry.raw);
      found = true;
    } catch {
      continue;
    }
  }
  return found ? decimalFromUnits(total, 6) : null;
}

export function resolveWalletOnchainStateVenueQuotas(
  total: number,
): WalletOnchainStateVenueQuotas {
  const safeTotal = Math.max(0, Math.floor(total));
  const polymarket = Math.floor(safeTotal * 0.5);
  const remaining = safeTotal - polymarket;
  const limitless = Math.floor(remaining / 2);
  const kalshi = remaining - limitless;
  return { polymarket, limitless, kalshi };
}

export function selectWalletOnchainStateCandidatesFromRanked<
  T extends { wallet_id: string; venue: WalletOnchainStateVenue },
>(
  candidates: readonly T[],
  total: number,
  quotas = resolveWalletOnchainStateVenueQuotas(total),
): T[] {
  const limit = Math.max(0, Math.floor(total));
  if (limit === 0 || candidates.length === 0) return [];

  const selectedWalletIds = new Set<string>();
  const selectedIndexes: number[] = [];
  const selectAtIndex = (index: number): boolean => {
    const candidate = candidates[index];
    if (!candidate || selectedWalletIds.has(candidate.wallet_id)) return false;
    selectedWalletIds.add(candidate.wallet_id);
    selectedIndexes.push(index);
    return true;
  };

  for (const venue of WALLET_ONCHAIN_STATE_VENUES) {
    let remaining = Math.max(0, Math.floor(quotas[venue] ?? 0));
    if (remaining === 0) continue;
    for (let index = 0; index < candidates.length; index += 1) {
      if (selectedWalletIds.size >= limit || remaining === 0) break;
      if (candidates[index]?.venue !== venue) continue;
      if (selectAtIndex(index)) remaining -= 1;
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    if (selectedWalletIds.size >= limit) break;
    selectAtIndex(index);
  }

  selectedIndexes.sort((a, b) => a - b);
  return selectedIndexes.slice(0, limit).map((index) => candidates[index] as T);
}

export function isWalletOnchainIdentityErrorFresh(
  metadata: Record<string, unknown> | null | undefined,
  errorStaleBefore: Date,
): boolean {
  if (!metadata) return false;
  if (metadata.walletOnchainIdentityCheckStatus !== "error") return false;
  const checkedAt = metadata.walletOnchainIdentityCheckedAt;
  if (typeof checkedAt !== "string") return false;
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return checkedAtMs >= errorStaleBefore.getTime();
}

function normalizeOwnerTail(code: string): string | null {
  const normalized = normalizeHexCode(code);
  const ownerHex = normalized.slice(-40);
  if (!/^[0-9a-f]{40}$/.test(ownerHex)) return null;
  return normalizeEvmAddress(`0x${ownerHex}`);
}

export function decodePolymarketDepositWalletOwnerFromRuntime(
  code: string | null | undefined,
): string | null {
  const normalized = normalizeHexCode(code);
  const hexLength = normalized.length - 2;
  if (hexLength !== POLYMARKET_DEPOSIT_RUNTIME_BYTES * 2) return null;
  if (!normalized.startsWith(POLYMARKET_DEPOSIT_RUNTIME_PREFIX)) return null;
  return normalizeOwnerTail(normalized);
}

export function decodeEip1167ImplementationFromRuntime(
  code: string | null | undefined,
): string | null {
  const normalized = normalizeHexCode(code);
  const expectedHexLength =
    2 +
    MAGIC_PROXY_RUNTIME_PREFIX.length -
    2 +
    40 +
    MAGIC_PROXY_RUNTIME_SUFFIX.length;
  if (normalized.length !== expectedHexLength) return null;
  if (!normalized.startsWith(MAGIC_PROXY_RUNTIME_PREFIX)) return null;
  if (!normalized.endsWith(MAGIC_PROXY_RUNTIME_SUFFIX)) return null;
  const implementation = normalized.slice(
    MAGIC_PROXY_RUNTIME_PREFIX.length,
    MAGIC_PROXY_RUNTIME_PREFIX.length + 40,
  );
  return normalizeEvmAddress(`0x${implementation}`);
}

export function isPolymarketMagicProxyRuntime(
  code: string | null | undefined,
  implementation = env.polymarketMagicProxyImplementation,
): boolean {
  const decoded = decodeEip1167ImplementationFromRuntime(code);
  const expected = normalizeEvmAddress(implementation);
  return Boolean(decoded && expected && decoded === expected);
}

export function classifyPolymarketWalletRuntime(input: {
  code: string | null | undefined;
  safeOwners?: string[] | null;
  safeThreshold?: number | null;
}): WalletIdentityInspection {
  const code = normalizeHexCode(input.code);
  if (isEmptyRuntime(code)) {
    return {
      walletKind: "eoa",
      ownerAddress: null,
      ownerSource: null,
      ownerConfidence: null,
      safeOwners: null,
      safeThreshold: null,
    };
  }

  const depositOwner = decodePolymarketDepositWalletOwnerFromRuntime(code);
  if (depositOwner) {
    return {
      walletKind: "polymarket_deposit_wallet",
      ownerAddress: depositOwner,
      ownerSource: "deposit_runtime_tail",
      ownerConfidence: "high",
      safeOwners: null,
      safeThreshold: null,
    };
  }

  if (isPolymarketMagicProxyRuntime(code)) {
    return {
      walletKind: "polymarket_magic_proxy",
      ownerAddress: null,
      ownerSource: null,
      ownerConfidence: null,
      safeOwners: null,
      safeThreshold: null,
    };
  }

  const safeOwners = (input.safeOwners ?? [])
    .map((owner) => normalizeEvmAddress(owner))
    .filter((owner): owner is string => Boolean(owner));
  const safeThreshold = input.safeThreshold ?? null;
  const safe =
    safeOwners.length > 0 &&
    safeThreshold != null &&
    safeThreshold >= 1 &&
    safeThreshold <= safeOwners.length;
  if (safe) {
    return {
      walletKind: "safe",
      ownerAddress: safeOwners.length === 1 ? safeOwners[0] : null,
      ownerSource: safeOwners.length === 1 ? "safe_getOwners" : null,
      ownerConfidence: safeOwners.length === 1 ? "high" : null,
      safeOwners,
      safeThreshold,
    };
  }

  return {
    walletKind: "contract_unknown",
    ownerAddress: null,
    ownerSource: null,
    ownerConfidence: null,
    safeOwners: null,
    safeThreshold: null,
  };
}

export async function inspectPolymarketWalletIdentity(input: {
  address: string;
}): Promise<WalletIdentityInspection> {
  const address = normalizeEvmAddress(input.address);
  if (!address) {
    return {
      walletKind: "contract_unknown",
      ownerAddress: null,
      ownerSource: null,
      ownerConfidence: null,
      safeOwners: null,
      safeThreshold: null,
    };
  }

  const code = await fetchEvmCode({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    address,
  });
  const codeIdentity = classifyPolymarketWalletRuntime({ code });
  if (codeIdentity.walletKind !== "contract_unknown") return codeIdentity;

  const safe = await inspectSafeWalletStrict({ address });
  if (safe.status === "safe") {
    return classifyPolymarketWalletRuntime({
      code,
      safeOwners: safe.owners,
      safeThreshold: safe.threshold,
    });
  }

  return codeIdentity;
}

function getEvmBalanceConfig(
  chain: WalletIntelChain,
): EvmChainBalanceConfig | null {
  if (chain === "polygon") {
    return {
      chain,
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      multicallAddress: POLYGON_MULTICALL_ADDRESS,
      native: {
        key: "pol",
        symbol: "POL",
        tokenAddress: EVM_NATIVE_ADDRESS,
        decimals: 18,
      },
      tokens: [
        {
          key: "pusd",
          symbol: "pUSD",
          tokenAddress: env.polymarketPusdAddress,
          decimals: 6,
        },
        {
          key: "usdce",
          symbol: "USDC.e",
          tokenAddress: env.polymarketUsdceAddress,
          decimals: 6,
        },
        {
          key: "usdc",
          symbol: "USDC",
          tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
          decimals: 6,
        },
      ],
    };
  }
  if (chain === "base") {
    return {
      chain,
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      multicallAddress: BASE_MULTICALL_ADDRESS,
      native: {
        key: "eth",
        symbol: "ETH",
        tokenAddress: EVM_NATIVE_ADDRESS,
        decimals: 18,
      },
      tokens: [
        {
          key: "usdc",
          symbol: "USDC",
          tokenAddress: env.limitlessUsdcAddress,
          decimals: 6,
        },
      ],
    };
  }
  return null;
}

function decodeErc20Balance(data: string): bigint {
  const decoded = ERC20_IFACE.decodeFunctionResult(
    "balanceOf",
    data,
  ) as unknown;
  const value = Array.isArray(decoded) ? decoded[0] : null;
  return typeof value === "bigint" ? value : 0n;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        output[index] = await mapper(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function fetchEvmLiquidBalances(
  wallets: BalanceWalletInput[],
  chain: Extract<WalletIntelChain, "polygon" | "base">,
): Promise<Map<string, WalletOnchainBalances>> {
  const config = getEvmBalanceConfig(chain);
  const balancesByAddress = new Map<string, WalletOnchainBalances>();
  if (!config || wallets.length === 0) return balancesByAddress;

  const normalizedWallets = wallets
    .map((wallet) => normalizeEvmAddress(wallet.address))
    .filter((address): address is string => Boolean(address));
  for (const address of normalizedWallets) balancesByAddress.set(address, {});

  for (const batch of chunkArray(normalizedWallets, 50)) {
    const calls = batch.flatMap((owner) =>
      config.tokens.map((token) => ({
        owner,
        token,
        call: {
          target: token.tokenAddress,
          callData: ERC20_IFACE.encodeFunctionData("balanceOf", [owner]),
          allowFailure: true,
        },
      })),
    );
    const results = await fetchEvmMulticall({
      rpcUrl: config.rpcUrl,
      timeoutMs: config.timeoutMs,
      multicallAddress: config.multicallAddress,
      calls: calls.map((entry) => entry.call),
    });

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (!call) continue;
      const result = results[index];
      const raw = result?.success ? decodeErc20Balance(result.returnData) : 0n;
      const entries = balancesByAddress.get(call.owner) ?? {};
      entries[call.token.key] = formatEvmBalanceEntry({
        chain,
        symbol: call.token.symbol,
        tokenAddress: call.token.tokenAddress,
        decimals: call.token.decimals,
        raw,
        isNative: false,
      });
      balancesByAddress.set(call.owner, entries);
    }
  }

  const nativeBalances = await fetchEvmNativeBalancesWithFallback({
    wallets: normalizedWallets.map((address) => ({ address, chain })),
    chain,
  });
  for (const owner of normalizedWallets) {
    const entries = balancesByAddress.get(owner) ?? {};
    entries[config.native.key] = formatEvmBalanceEntry({
      chain,
      symbol: config.native.symbol,
      tokenAddress: config.native.tokenAddress,
      decimals: config.native.decimals,
      raw: nativeBalances.get(owner) ?? 0n,
      isNative: true,
    });
    balancesByAddress.set(owner, entries);
  }

  return balancesByAddress;
}

async function fetchEvmNativeBalancesMulticall(input: {
  addresses: string[];
  config: EvmChainBalanceConfig;
}): Promise<Map<string, bigint>> {
  const output = new Map<string, bigint>();
  for (const batch of chunkArray(input.addresses, 100)) {
    const calls = batch.map((address) => ({
      owner: address,
      call: {
        target: input.config.multicallAddress,
        callData: MULTICALL3_IFACE.encodeFunctionData("getEthBalance", [
          address,
        ]),
        allowFailure: true,
      },
    }));
    const results = await fetchEvmMulticall({
      rpcUrl: input.config.rpcUrl,
      timeoutMs: input.config.timeoutMs,
      multicallAddress: input.config.multicallAddress,
      calls: calls.map((entry) => entry.call),
    });
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (!call) continue;
      const result = results[index];
      if (!result?.success) {
        throw new Error("EVM native multicall balance lookup failed");
      }
      const decoded = MULTICALL3_IFACE.decodeFunctionResult(
        "getEthBalance",
        result.returnData,
      ) as unknown;
      const raw = Array.isArray(decoded) ? decoded[0] : null;
      if (typeof raw !== "bigint") {
        throw new Error("EVM native multicall returned invalid balance");
      }
      output.set(call.owner, raw);
    }
  }
  return output;
}

export async function fetchEvmNativeBalancesWithFallback(input: {
  wallets: BalanceWalletInput[];
  chain: Extract<WalletIntelChain, "polygon" | "base">;
  fetchers?: EvmNativeBalanceFetchers;
}): Promise<Map<string, bigint>> {
  const config = getEvmBalanceConfig(input.chain);
  const output = new Map<string, bigint>();
  if (!config || input.wallets.length === 0) return output;

  const addresses = Array.from(
    new Map(
      input.wallets.flatMap((wallet) => {
        const address = normalizeEvmAddress(wallet.address);
        return address ? [[address, address]] : [];
      }),
    ).values(),
  );
  if (addresses.length === 0) return output;

  const batchFetcher =
    input.fetchers?.batch ??
    ((batchAddresses: string[]) =>
      fetchEvmNativeBalancesMulticall({
        addresses: batchAddresses,
        config,
      }));
  const singleFetcher =
    input.fetchers?.single ??
    ((address: string) =>
      fetchEvmBalance({
        rpcUrl: config.rpcUrl,
        timeoutMs: config.timeoutMs,
        address,
      }));

  try {
    const batchBalances = await batchFetcher(addresses);
    for (const address of addresses) {
      output.set(address, batchBalances.get(address) ?? 0n);
    }
    return output;
  } catch {
    await mapWithConcurrency(addresses, 8, async (address): Promise<void> => {
      try {
        output.set(address, await singleFetcher(address));
      } catch {
        output.set(address, 0n);
      }
    });
    return output;
  }
}

async function fetchSolanaLiquidBalances(
  wallets: BalanceWalletInput[],
): Promise<Map<string, WalletOnchainBalances>> {
  const balancesByAddress = new Map<string, WalletOnchainBalances>();
  await mapWithConcurrency(wallets, 8, async (wallet): Promise<void> => {
    const address = wallet.address.trim();
    if (!address) return;
    let lamports = 0n;
    try {
      lamports = await fetchSolanaBalanceLamports({
        rpcUrls: env.solanaRpcUrls,
        owner: address,
        timeoutMs: env.solanaRpcTimeoutMs,
      });
    } catch {
      lamports = 0n;
    }

    let usdcRaw = 0n;
    try {
      const tokenBalance = await fetchSolanaTokenBalanceByOwnerAndMint({
        rpcUrls: env.solanaRpcUrls,
        owner: address,
        mint: env.solanaUsdcMint,
        timeoutMs: env.solanaRpcTimeoutMs,
      });
      usdcRaw = tokenBalance?.amount ?? 0n;
    } catch {
      usdcRaw = 0n;
    }

    balancesByAddress.set(address, {
      usdc: {
        chain: "solana",
        symbol: "USDC",
        tokenAddress: env.solanaUsdcMint,
        decimals: 6,
        raw: usdcRaw.toString(),
        amount: formatUiAmount(usdcRaw, 6),
        isNative: false,
      },
      sol: {
        chain: "solana",
        symbol: "SOL",
        tokenAddress: SOLANA_NATIVE_ADDRESS,
        decimals: 9,
        raw: lamports.toString(),
        amount: formatUiAmount(lamports, 9),
        isNative: true,
      },
    });
  });
  return balancesByAddress;
}

export async function fetchWalletLiquidBalances(
  wallets: BalanceWalletInput[],
): Promise<Map<string, WalletOnchainBalances>> {
  const result = await fetchWalletLiquidBalancesPartial(wallets);
  return result.balances;
}

export async function fetchWalletLiquidBalancesPartial(
  wallets: BalanceWalletInput[],
  fetchers: WalletLiquidBalanceFetchers = {
    polygon: (chainWallets) => fetchEvmLiquidBalances(chainWallets, "polygon"),
    base: (chainWallets) => fetchEvmLiquidBalances(chainWallets, "base"),
    solana: fetchSolanaLiquidBalances,
  },
): Promise<WalletLiquidBalanceFetchResult> {
  const output = new Map<string, WalletOnchainBalances>();
  const byChain = new Map<WalletIntelChain, BalanceWalletInput[]>();
  for (const wallet of wallets) {
    const normalized = normalizeBalanceWalletInput(wallet);
    if (!normalized) continue;
    const bucket = byChain.get(wallet.chain) ?? [];
    const existing = new Set(bucket.map((entry) => entry.address));
    if (!existing.has(normalized.address)) bucket.push(normalized);
    byChain.set(normalized.chain, bucket);
  }

  const merge = (
    chain: WalletIntelChain,
    balances: Map<string, WalletOnchainBalances>,
  ) => {
    for (const [address, balance] of balances.entries()) {
      output.set(walletBalanceMapKey(chain, address), balance);
    }
  };

  const polygon = byChain.get("polygon") ?? [];
  const base = byChain.get("base") ?? [];
  const solana = byChain.get("solana") ?? [];
  const errors: WalletLiquidBalanceFetchError[] = [];
  const chainInputs: Array<[WalletIntelChain, BalanceWalletInput[]]> = [
    ["polygon", polygon],
    ["base", base],
    ["solana", solana],
  ];
  await Promise.all(
    chainInputs.map(async ([chain, chainWallets]) => {
      if (chainWallets.length === 0) return;
      const fetcher = fetchers[chain];
      if (!fetcher) return;
      try {
        merge(chain, await fetcher(chainWallets));
      } catch (error) {
        errors.push({ chain, error });
      }
    }),
  );
  return { balances: output, errors };
}
