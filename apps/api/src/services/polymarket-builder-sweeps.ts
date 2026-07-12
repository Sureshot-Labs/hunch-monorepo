import { ethers } from "ethers";
import type { Pool } from "pg";

import { env } from "../env.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import {
  buildDepositWalletBatchTypedData,
  POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS,
  type DepositWalletCall,
} from "./polymarket-deposit-wallet-relayer.js";

export { buildDepositWalletBatchTypedData } from "./polymarket-deposit-wallet-relayer.js";

const RELAYER_BASE_URL = "https://relayer-v2.polymarket.com";
const SUCCESS_RELAYER_STATES = new Set(["STATE_MINED", "STATE_CONFIRMED"]);
const FAILED_RELAYER_STATES = new Set(["STATE_FAILED", "STATE_INVALID"]);

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
] as const;

const DEPOSIT_WALLET_OWNER_ABI = [
  "function owner() view returns (address)",
] as const;

type RelayerTransaction = {
  transactionID?: string;
  transactionHash?: string;
  state?: string;
};

type InFlightSweepRow = {
  id: string;
  amount_raw: string;
  pre_hot_balance_raw: string | null;
  relayer_transaction_id: string | null;
  tx_hash: string | null;
  relayer_state: string | null;
};

export type PolymarketBuilderSweepResult = {
  status:
    | "disabled"
    | "skipped"
    | "planned"
    | "submitted"
    | "confirmed"
    | "failed";
  reason?: string | null;
  sweepId?: string | null;
  builderAddress?: string | null;
  ownerAddress?: string | null;
  hotAddress?: string | null;
  tokenAddress?: string | null;
  amountRaw?: string | null;
  amount?: string | null;
  relayerTransactionId?: string | null;
  txHash?: string | null;
  relayerState?: string | null;
  error?: string | null;
};

export function computePolymarketBuilderSweepAmount(inputs: {
  balanceRaw: bigint;
  minRaw?: bigint;
  maxRaw?: bigint;
  reserveRaw?: bigint;
}): { amountRaw: bigint; reason: string | null } {
  const minRaw = inputs.minRaw ?? 0n;
  const maxRaw = inputs.maxRaw ?? 0n;
  const reserveRaw = inputs.reserveRaw ?? 0n;
  if (inputs.balanceRaw <= reserveRaw) {
    return {
      amountRaw: 0n,
      reason: reserveRaw > 0n ? "reserved_builder_balance" : "no_balance",
    };
  }
  const availableRaw = inputs.balanceRaw - reserveRaw;
  const cappedRaw =
    maxRaw > 0n && availableRaw > maxRaw ? maxRaw : availableRaw;
  if (cappedRaw <= 0n) return { amountRaw: 0n, reason: "no_available_balance" };
  if (minRaw > 0n && cappedRaw < minRaw) {
    return { amountRaw: 0n, reason: "below_min_sweep" };
  }
  return { amountRaw: cappedRaw, reason: null };
}

export function deriveAddressFromPrivateKey(privateKey: string): string {
  const normalized = normalizePrivateKey(privateKey);
  return ethers.getAddress(new ethers.Wallet(normalized).address);
}

export async function runPolymarketBuilderSweep(
  db: Pool,
  options: { dryRun: boolean; execute: boolean },
): Promise<PolymarketBuilderSweepResult> {
  if (!env.polymarketBuilderSweepEnabled) {
    return {
      status: "disabled",
      reason: "POLYMARKET_BUILDER_SWEEP_ENABLED=false",
    };
  }

  const configured = resolveSweepConfig();
  if (!configured.ok) {
    return {
      status: "skipped",
      reason: "invalid_config",
      error: configured.error,
    };
  }

  const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
  const token = new ethers.Contract(
    configured.tokenAddress,
    ERC20_ABI,
    provider,
  );
  let builderBalanceRaw: bigint;
  let hotBalanceRaw: bigint;
  try {
    await validateOnchainConfig(provider, configured);
    [builderBalanceRaw, hotBalanceRaw] = await Promise.all([
      token.balanceOf(configured.builderAddress) as Promise<bigint>,
      token.balanceOf(configured.hotAddress) as Promise<bigint>,
    ]);
  } catch (error) {
    return {
      status: "failed",
      reason: "onchain_read_failed",
      error: describeError(error),
      builderAddress: configured.builderAddress,
      ownerAddress: configured.ownerAddress,
      hotAddress: configured.hotAddress,
      tokenAddress: configured.tokenAddress,
    };
  }
  const amount = computePolymarketBuilderSweepAmount({
    balanceRaw: builderBalanceRaw,
    minRaw: env.polymarketBuilderSweepMinRaw,
    maxRaw: env.polymarketBuilderSweepMaxRaw,
    reserveRaw: env.polymarketBuilderSweepReserveRaw,
  });

  const baseResult = {
    builderAddress: configured.builderAddress,
    ownerAddress: configured.ownerAddress,
    hotAddress: configured.hotAddress,
    tokenAddress: configured.tokenAddress,
    amountRaw: amount.amountRaw.toString(),
    amount: usdcMicroToDecimalString(amount.amountRaw),
  };

  if (amount.amountRaw <= 0n) {
    return { status: "skipped", reason: amount.reason, ...baseResult };
  }

  if (options.dryRun || !options.execute) {
    return { status: "planned", reason: "dry_run", ...baseResult };
  }

  const ledgerAvailable = await hasSweepLedger(db);
  if (!ledgerAvailable) {
    return {
      status: "skipped",
      reason: "missing_sweep_ledger",
      error: "polymarket_builder_sweeps table is missing",
      ...baseResult,
    };
  }

  await failStalePreparingSweeps(db);
  const inFlight = await fetchInFlightSweep(db, configured);
  if (inFlight) {
    const refreshed = await refreshInFlightSweep(db, {
      configured,
      provider,
      token,
      inFlight,
    });
    if (refreshed) {
      return refreshed;
    }
    return {
      status: "skipped",
      reason: "in_flight_sweep",
      sweepId: inFlight.id,
      relayerTransactionId: inFlight.relayer_transaction_id,
      txHash: inFlight.tx_hash,
      relayerState: inFlight.relayer_state,
      ...baseResult,
    };
  }

  let sweepId: string | null = null;
  try {
    sweepId = await insertPreparingSweep(db, {
      configured,
      amountRaw: amount.amountRaw,
      preBuilderBalanceRaw: builderBalanceRaw,
      preHotBalanceRaw: hotBalanceRaw,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: "skipped", reason: "in_flight_sweep", ...baseResult };
    }
    return {
      status: "failed",
      reason: "ledger_insert_failed",
      error: describeError(error),
      ...baseResult,
    };
  }

  try {
    const nonce = await fetchRelayerNonce(configured.ownerAddress);
    const deadline = (Math.floor(Date.now() / 1000) + 15 * 60).toString();
    const transferData = new ethers.Interface(ERC20_ABI).encodeFunctionData(
      "transfer",
      [configured.hotAddress, amount.amountRaw],
    );
    const calls: DepositWalletCall[] = [
      {
        target: configured.tokenAddress,
        value: "0",
        data: transferData,
      },
    ];
    const typedData = buildDepositWalletBatchTypedData({
      depositWalletAddress: configured.builderAddress,
      nonce,
      deadline,
      calls,
    });
    const signature = await configured.ownerWallet.signTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
    );
    const submitBody = {
      type: "WALLET",
      from: configured.ownerAddress,
      to: POLYMARKET_DEPOSIT_WALLET_FACTORY_ADDRESS,
      nonce,
      signature,
      depositWalletParams: {
        depositWallet: configured.builderAddress,
        deadline,
        calls,
      },
    };
    const submit = await submitRelayerTransaction(submitBody);
    const relayerTransactionId = submit.transactionID;
    if (!relayerTransactionId) {
      throw new Error("relayer submit did not return transactionID");
    }
    await markSweepSubmitted(db, {
      sweepId,
      relayerTransactionId,
      relayerState: submit.state ?? null,
    });

    const transaction = await pollRelayerTransaction(relayerTransactionId);
    if (!transaction.latest) {
      await markSweepBroadcast(db, {
        sweepId,
        relayerTransactionId,
        relayerState: submit.state ?? "STATE_NEW",
        txHash: null,
      });
      return {
        status: "submitted",
        reason: "relayer_pending",
        sweepId,
        relayerTransactionId,
        relayerState: submit.state ?? "STATE_NEW",
        ...baseResult,
      };
    }
    if (FAILED_RELAYER_STATES.has(transaction.latest.state ?? "")) {
      throw new Error(
        `relayer transaction failed: ${transaction.latest.state}`,
      );
    }
    if (!transaction.success) {
      await markSweepBroadcast(db, {
        sweepId,
        relayerTransactionId,
        relayerState: transaction.latest.state ?? "STATE_NEW",
        txHash: transaction.latest.transactionHash || null,
      });
      return {
        status: "submitted",
        reason: "relayer_pending",
        sweepId,
        relayerTransactionId,
        txHash: transaction.latest.transactionHash || null,
        relayerState: transaction.latest.state ?? "STATE_NEW",
        ...baseResult,
      };
    }

    const txHash = transaction.latest.transactionHash || null;
    if (txHash) {
      await provider.waitForTransaction(txHash, 1, 60_000).catch(() => null);
    }
    const [postBuilderBalanceRaw, postHotBalanceRaw] = await Promise.all([
      token.balanceOf(configured.builderAddress) as Promise<bigint>,
      token.balanceOf(configured.hotAddress) as Promise<bigint>,
    ]);
    if (postHotBalanceRaw - hotBalanceRaw < amount.amountRaw) {
      throw new Error(
        "post-check failed: rewards hot wallet balance did not increase by sweep amount",
      );
    }

    await markSweepConfirmed(db, {
      sweepId,
      txHash,
      relayerState: transaction.latest.state ?? null,
      postBuilderBalanceRaw,
      postHotBalanceRaw,
    });
    return {
      status: "confirmed",
      sweepId,
      relayerTransactionId,
      txHash,
      relayerState: transaction.latest.state ?? null,
      ...baseResult,
    };
  } catch (error) {
    await markSweepFailed(db, {
      sweepId,
      error: describeError(error),
    }).catch(() => undefined);
    return {
      status: "failed",
      sweepId,
      error: describeError(error),
      ...baseResult,
    };
  }
}

type ResolvedSweepConfig = {
  ok: true;
  builderAddress: string;
  ownerAddress: string;
  hotAddress: string;
  tokenAddress: string;
  ownerWallet: ethers.Wallet;
};

function resolveSweepConfig():
  | ResolvedSweepConfig
  | { ok: false; error: string } {
  if (!env.polymarketBuilderAddress) {
    return { ok: false, error: "missing POLYMARKET_BUILDER_ADDRESS" };
  }
  if (!env.polymarketBuilderOwnerAddress) {
    return { ok: false, error: "missing POLYMARKET_BUILDER_OWNER_ADDRESS" };
  }
  if (!env.polymarketRelayerPrivateKey) {
    return { ok: false, error: "missing POLYMARKET_RELAYER_PRIVATE_KEY" };
  }
  if (!env.polymarketRelayerApiKey) {
    return { ok: false, error: "missing POLYMARKET_RELAYER_API_KEY" };
  }
  if (!env.polymarketRelayerApiKeyAddress) {
    return { ok: false, error: "missing POLYMARKET_RELAYER_API_KEY_ADDRESS" };
  }
  const payoutPrivateKey =
    env.rewardsPayoutPrivateKeyPolygon?.trim() ||
    env.rewardsPayoutPrivateKey?.trim();
  if (!payoutPrivateKey) {
    return { ok: false, error: "missing polygon rewards hot wallet key" };
  }
  const rewardsToken =
    env.rewardsPayoutTokenAddressPolygon?.trim() || env.polymarketPusdAddress;
  if (!sameAddress(rewardsToken, env.polymarketPusdAddress)) {
    return {
      ok: false,
      error: "polygon rewards token must be Polymarket pUSD for builder sweeps",
    };
  }

  try {
    const builderAddress = ethers.getAddress(env.polymarketBuilderAddress);
    const ownerAddress = ethers.getAddress(env.polymarketBuilderOwnerAddress);
    const relayerApiKeyAddress = ethers.getAddress(
      env.polymarketRelayerApiKeyAddress,
    );
    const ownerWallet = new ethers.Wallet(
      normalizePrivateKey(env.polymarketRelayerPrivateKey),
    );
    const derivedOwner = ethers.getAddress(ownerWallet.address);
    if (!sameAddress(derivedOwner, ownerAddress)) {
      return {
        ok: false,
        error:
          "POLYMARKET_RELAYER_PRIVATE_KEY does not derive POLYMARKET_BUILDER_OWNER_ADDRESS",
      };
    }
    if (!sameAddress(relayerApiKeyAddress, ownerAddress)) {
      return {
        ok: false,
        error:
          "POLYMARKET_RELAYER_API_KEY_ADDRESS must match POLYMARKET_BUILDER_OWNER_ADDRESS",
      };
    }
    const hotAddress = ethers.getAddress(
      new ethers.Wallet(normalizePrivateKey(payoutPrivateKey)).address,
    );
    const tokenAddress = ethers.getAddress(env.polymarketPusdAddress);
    return {
      ok: true,
      builderAddress,
      ownerAddress,
      hotAddress,
      tokenAddress,
      ownerWallet,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function validateOnchainConfig(
  provider: ethers.JsonRpcProvider,
  configured: ResolvedSweepConfig,
): Promise<void> {
  const code = await provider.getCode(configured.builderAddress);
  if (!code || code === "0x") {
    throw new Error("POLYMARKET_BUILDER_ADDRESS has no bytecode");
  }
  const wallet = new ethers.Contract(
    configured.builderAddress,
    DEPOSIT_WALLET_OWNER_ABI,
    provider,
  );
  const owner = ethers.getAddress(await wallet.owner());
  if (!sameAddress(owner, configured.ownerAddress)) {
    throw new Error(
      "DepositWallet owner does not match POLYMARKET_BUILDER_OWNER_ADDRESS",
    );
  }
}

async function hasSweepLedger(db: Pool): Promise<boolean> {
  const { rows } = await db.query<{ table_name: string | null }>(
    `select to_regclass('public.polymarket_builder_sweeps')::text as table_name`,
  );
  return Boolean(rows[0]?.table_name);
}

async function failStalePreparingSweeps(db: Pool): Promise<void> {
  await db.query(
    `
      update polymarket_builder_sweeps
      set state = 'failed',
          error = coalesce(error, 'stale preparing sweep'),
          failed_at = coalesce(failed_at, now()),
          updated_at = now()
      where state = 'preparing'
        and created_at < now() - interval '10 minutes'
    `,
  );
}

async function fetchInFlightSweep(
  db: Pool,
  configured: ResolvedSweepConfig,
): Promise<InFlightSweepRow | null> {
  const { rows } = await db.query<InFlightSweepRow>(
    `
      select
        id,
        amount_raw,
        pre_hot_balance_raw,
        relayer_transaction_id,
        tx_hash,
        relayer_state
      from polymarket_builder_sweeps
      where lower(builder_address) = lower($1)
        and lower(token_address) = lower($2)
        and lower(destination_address) = lower($3)
        and state in ('preparing', 'submitted', 'broadcast')
      order by created_at desc, id desc
      limit 1
    `,
    [configured.builderAddress, configured.tokenAddress, configured.hotAddress],
  );
  return rows[0] ?? null;
}

async function refreshInFlightSweep(
  db: Pool,
  inputs: {
    configured: ResolvedSweepConfig;
    provider: ethers.JsonRpcProvider;
    token: ethers.Contract;
    inFlight: InFlightSweepRow;
  },
): Promise<PolymarketBuilderSweepResult | null> {
  const transactionId = inputs.inFlight.relayer_transaction_id;
  if (!transactionId) return null;
  const latest = await fetchRelayerTransaction(transactionId).catch(() => null);
  if (!latest) return null;
  if (FAILED_RELAYER_STATES.has(latest.state ?? "")) {
    await markSweepFailed(db, {
      sweepId: inputs.inFlight.id,
      error: `relayer transaction failed: ${latest.state}`,
    });
    return {
      status: "failed",
      sweepId: inputs.inFlight.id,
      relayerTransactionId: transactionId,
      txHash: latest.transactionHash || inputs.inFlight.tx_hash,
      relayerState: latest.state ?? null,
      error: `relayer transaction failed: ${latest.state}`,
    };
  }
  if (!SUCCESS_RELAYER_STATES.has(latest.state ?? "")) {
    await markSweepBroadcast(db, {
      sweepId: inputs.inFlight.id,
      relayerTransactionId: transactionId,
      relayerState: latest.state ?? "STATE_NEW",
      txHash: latest.transactionHash || null,
    });
    return null;
  }

  const amountRaw = BigInt(inputs.inFlight.amount_raw);
  const preHotBalanceRaw = BigInt(inputs.inFlight.pre_hot_balance_raw ?? "0");
  const txHash = latest.transactionHash || inputs.inFlight.tx_hash;
  if (txHash) {
    await inputs.provider
      .waitForTransaction(txHash, 1, 60_000)
      .catch(() => null);
  }
  const [postBuilderBalanceRaw, postHotBalanceRaw] = await Promise.all([
    inputs.token.balanceOf(inputs.configured.builderAddress) as Promise<bigint>,
    inputs.token.balanceOf(inputs.configured.hotAddress) as Promise<bigint>,
  ]);
  if (postHotBalanceRaw - preHotBalanceRaw < amountRaw) {
    return null;
  }
  await markSweepConfirmed(db, {
    sweepId: inputs.inFlight.id,
    txHash: txHash || null,
    relayerState: latest.state ?? null,
    postBuilderBalanceRaw,
    postHotBalanceRaw,
  });
  return {
    status: "confirmed",
    sweepId: inputs.inFlight.id,
    relayerTransactionId: transactionId,
    txHash: txHash || null,
    relayerState: latest.state ?? null,
    amountRaw: amountRaw.toString(),
    amount: usdcMicroToDecimalString(amountRaw),
    builderAddress: inputs.configured.builderAddress,
    ownerAddress: inputs.configured.ownerAddress,
    hotAddress: inputs.configured.hotAddress,
    tokenAddress: inputs.configured.tokenAddress,
  };
}

async function insertPreparingSweep(
  db: Pool,
  inputs: {
    configured: ResolvedSweepConfig;
    amountRaw: bigint;
    preBuilderBalanceRaw: bigint;
    preHotBalanceRaw: bigint;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `
      insert into polymarket_builder_sweeps (
        builder_address,
        owner_address,
        destination_address,
        token_address,
        token_symbol,
        amount_raw,
        amount,
        pre_builder_balance_raw,
        pre_hot_balance_raw,
        state
      )
      values ($1, $2, $3, $4, 'pUSD', $5, $6::numeric, $7, $8, 'preparing')
      returning id
    `,
    [
      inputs.configured.builderAddress,
      inputs.configured.ownerAddress,
      inputs.configured.hotAddress,
      inputs.configured.tokenAddress,
      inputs.amountRaw.toString(),
      usdcMicroToDecimalString(inputs.amountRaw),
      inputs.preBuilderBalanceRaw.toString(),
      inputs.preHotBalanceRaw.toString(),
    ],
  );
  return rows[0]?.id ?? "";
}

async function markSweepSubmitted(
  db: Pool,
  inputs: {
    sweepId: string;
    relayerTransactionId: string;
    relayerState: string | null;
  },
): Promise<void> {
  await db.query(
    `
      update polymarket_builder_sweeps
      set state = 'submitted',
          relayer_transaction_id = $2,
          relayer_state = $3,
          submitted_at = now(),
          updated_at = now()
      where id = $1
    `,
    [inputs.sweepId, inputs.relayerTransactionId, inputs.relayerState],
  );
}

async function markSweepBroadcast(
  db: Pool,
  inputs: {
    sweepId: string;
    relayerTransactionId: string;
    relayerState: string;
    txHash: string | null;
  },
): Promise<void> {
  await db.query(
    `
      update polymarket_builder_sweeps
      set state = 'broadcast',
          relayer_transaction_id = $2,
          relayer_state = $3,
          tx_hash = coalesce($4, tx_hash),
          broadcast_at = coalesce(broadcast_at, now()),
          updated_at = now()
      where id = $1
    `,
    [
      inputs.sweepId,
      inputs.relayerTransactionId,
      inputs.relayerState,
      inputs.txHash,
    ],
  );
}

async function markSweepConfirmed(
  db: Pool,
  inputs: {
    sweepId: string;
    txHash: string | null;
    relayerState: string | null;
    postBuilderBalanceRaw: bigint;
    postHotBalanceRaw: bigint;
  },
): Promise<void> {
  await db.query(
    `
      update polymarket_builder_sweeps
      set state = 'confirmed',
          tx_hash = coalesce($2, tx_hash),
          relayer_state = coalesce($3, relayer_state),
          post_builder_balance_raw = $4,
          post_hot_balance_raw = $5,
          broadcast_at = case when $2 is not null then coalesce(broadcast_at, now()) else broadcast_at end,
          confirmed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [
      inputs.sweepId,
      inputs.txHash,
      inputs.relayerState,
      inputs.postBuilderBalanceRaw.toString(),
      inputs.postHotBalanceRaw.toString(),
    ],
  );
}

async function markSweepFailed(
  db: Pool,
  inputs: { sweepId: string | null; error: string },
): Promise<void> {
  if (!inputs.sweepId) return;
  await db.query(
    `
      update polymarket_builder_sweeps
      set state = 'failed',
          error = $2,
          failed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [inputs.sweepId, inputs.error],
  );
}

async function fetchRelayerNonce(ownerAddress: string): Promise<string> {
  const url = new URL("/nonce", RELAYER_BASE_URL);
  url.searchParams.set("address", ownerAddress);
  url.searchParams.set("type", "WALLET");
  const payload = await fetchRelayerJson<{ nonce?: string }>(url.toString(), {
    method: "GET",
  });
  if (!payload.nonce) throw new Error("relayer nonce response missing nonce");
  return payload.nonce;
}

async function submitRelayerTransaction(
  body: unknown,
): Promise<{ transactionID?: string; state?: string }> {
  return fetchRelayerJson(`${RELAYER_BASE_URL}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      RELAYER_API_KEY: env.polymarketRelayerApiKey,
      RELAYER_API_KEY_ADDRESS: env.polymarketRelayerApiKeyAddress,
    },
    body: JSON.stringify(body),
  });
}

async function pollRelayerTransaction(
  transactionId: string,
): Promise<{ latest: RelayerTransaction | null; success: boolean }> {
  let latest: RelayerTransaction | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const transaction = await fetchRelayerTransaction(transactionId);
    if (transaction) {
      latest = transaction;
      if (
        SUCCESS_RELAYER_STATES.has(transaction.state ?? "") ||
        FAILED_RELAYER_STATES.has(transaction.state ?? "")
      ) {
        return {
          latest: transaction,
          success: SUCCESS_RELAYER_STATES.has(transaction.state ?? ""),
        };
      }
    }
    await sleep(2_000);
  }
  return { latest, success: false };
}

async function fetchRelayerTransaction(
  transactionId: string,
): Promise<RelayerTransaction | null> {
  const url = new URL("/transaction", RELAYER_BASE_URL);
  url.searchParams.set("id", transactionId);
  const payload = await fetchRelayerJson<
    RelayerTransaction[] | RelayerTransaction
  >(url.toString(), { method: "GET" });
  if (Array.isArray(payload)) return payload[0] ?? null;
  return payload;
}

async function fetchRelayerJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    throw new Error(
      readRelayerError(payload, `relayer request failed: ${res.status}`),
    );
  }
  return payload as T;
}

function readRelayerError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error", "statusText"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const data = record.data;
    if (data && typeof data === "object") {
      const message = (data as Record<string, unknown>).error;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return fallback;
}

function normalizePrivateKey(privateKey: string): string {
  const trimmed = privateKey.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function sameAddress(left: string, right: string): boolean {
  if (!left || !right) return false;
  try {
    return ethers.getAddress(left) === ethers.getAddress(right);
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
