import { Interface } from "ethers";
import { isRecord } from "../lib/type-guards.js";
import {
  factsFromEvidence,
  type VerifiedPurchaseEvidence,
} from "./verified-buy.js";
import type { VerifiedBuyFacts } from "../schemas/social-trade.js";

const fillV1 = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const fillV2 = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
]);
const transfers = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
const amm = new Interface([
  "event FPMMBuy(address indexed buyer,uint256 investmentAmount,uint256 feeAmount,uint256 indexed outcomeIndex,uint256 outcomeTokensBought)",
]);

type Log = { address: string; topics: string[]; data: string; index: number };
function receiptLogs(receipt: unknown, txHash: string): Log[] | null {
  if (
    !isRecord(receipt) ||
    (receipt.status !== 1 && receipt.status !== "0x1") ||
    String(receipt.hash ?? receipt.transactionHash).toLowerCase() !==
      txHash.toLowerCase() ||
    !Array.isArray(receipt.logs)
  )
    return null;
  const result: Log[] = [];
  for (const value of receipt.logs) {
    if (
      !isRecord(value) ||
      typeof value.address !== "string" ||
      typeof value.data !== "string" ||
      !Array.isArray(value.topics) ||
      !value.topics.every((t) => typeof t === "string")
    )
      return null;
    const index =
      typeof value.index === "number" ? value.index : Number(value.logIndex);
    if (!Number.isSafeInteger(index) || index < 0) return null;
    result.push({
      address: value.address.toLowerCase(),
      data: value.data,
      topics: value.topics,
      index,
    });
  }
  return result;
}

function tokenNet(
  logs: Log[],
  positionContract: string,
  owner: string,
  tokenId: string,
): bigint | null {
  let total = 0n;
  for (const log of logs) {
    if (log.address !== positionContract.toLowerCase()) continue;
    let parsed;
    try {
      parsed = transfers.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    const sign =
      (String(parsed.args.to).toLowerCase() === owner.toLowerCase() ? 1n : 0n) -
      (String(parsed.args.from).toLowerCase() === owner.toLowerCase()
        ? 1n
        : 0n);
    if (!sign) continue;
    if (parsed.name === "TransferSingle") {
      if (String(parsed.args.id) === tokenId) {
        // An outgoing transfer may be a separate sale, not a fee on this buy.
        // Without leg-level allocation it cannot reduce the snapshot's shares.
        if (sign < 0n && BigInt(parsed.args.value) > 0n) return null;
        total += sign * BigInt(parsed.args.value);
      }
    } else {
      const ids = parsed.args[3] as bigint[];
      const values = parsed.args[4] as bigint[];
      for (let i = 0; i < ids.length; i++)
        if (String(ids[i]) === tokenId) {
          if (sign < 0n && (values[i] ?? 0n) > 0n) return null;
          total += sign * (values[i] ?? 0n);
        }
    }
  }
  return total;
}

export type EvmBuyEvidenceInput = {
  receipt: unknown;
  txHash: string;
  owner: string;
  orderHash: string;
  exchangeAddress: string;
  positionContract: string;
  tokenId: string;
  chainId: number;
  providerOrderId?: string;
  instrument: VerifiedBuyFacts["instrument"];
  purchasedAt: string;
};

/** Receipt and block timestamp must come from the configured chain, not a recorder body. */
export function parseEvmClobBuyEvidence(
  input: EvmBuyEvidenceInput,
): VerifiedPurchaseEvidence | null {
  const logs = receiptLogs(input.receipt, input.txHash);
  if (!logs || !/^0x[0-9a-f]{64}$/i.test(input.orderHash)) return null;
  let notional = 0n,
    shares = 0n;
  const evidenceIds: string[] = [];
  const sameAssetPurchases = new Set<string>();
  for (const log of logs) {
    if (log.address !== input.exchangeAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = fillV2.parseLog(log);
    } catch {
      /* legacy exchange */
    }
    if (!parsed)
      try {
        parsed = fillV1.parseLog(log);
      } catch {
        continue;
      }
    if (
      !parsed ||
      String(parsed.args.maker).toLowerCase() !== input.owner.toLowerCase()
    )
      continue;
    const isV2 = parsed.args.side !== undefined;
    const isBuy = isV2
      ? BigInt(parsed.args.side) === 0n
      : BigInt(parsed.args.makerAssetId) === 0n;
    const tokenId = String(
      isV2 ? parsed.args.tokenId : parsed.args.takerAssetId,
    );
    if (!isBuy || tokenId !== input.tokenId) continue;
    const hash = String(parsed.args.orderHash).toLowerCase();
    sameAssetPurchases.add(hash);
    if (hash !== input.orderHash.toLowerCase()) continue;
    notional += BigInt(parsed.args.makerAmountFilled);
    shares += BigInt(parsed.args.takerAmountFilled);
    evidenceIds.push(
      `${input.chainId}:${input.txHash.toLowerCase()}:${log.index}`,
    );
  }
  // A wallet-level token delta cannot allocate fees between same-token orders.
  if (sameAssetPurchases.size !== 1 || notional <= 0n || shares <= 0n)
    return null;
  const netShares = tokenNet(
    logs,
    input.positionContract,
    input.owner,
    input.tokenId,
  );
  if (netShares === null || netShares <= 0n || netShares > shares) return null;
  const canonicalPurchaseKey =
    input.instrument.venue === "polymarket"
      ? `polymarket:${input.chainId}:${input.exchangeAddress.toLowerCase()}:${input.orderHash.toLowerCase()}`
      : input.providerOrderId
        ? `limitless:clob:${input.chainId}:${input.providerOrderId}`
        : null;
  if (!canonicalPurchaseKey) return null;
  return {
    canonicalPurchaseKey,
    instrument: input.instrument,
    owner: input.owner.toLowerCase(),
    notionalRaw: notional,
    grossSharesRaw: shares,
    netSharesRaw: netShares,
    collateralDecimals: 6,
    shareDecimals: 6,
    feesUsdRaw: null,
    purchasedAt: input.purchasedAt,
    evidenceIds,
  };
}

export function parseEvmAmmBuyEvidence(
  input: Omit<EvmBuyEvidenceInput, "orderHash" | "exchangeAddress"> & {
    marketAddress: string;
    outcomeIndex: number;
  },
): VerifiedPurchaseEvidence | null {
  const logs = receiptLogs(input.receipt, input.txHash);
  if (!logs) return null;
  const matched: Array<{
    log: Log;
    investment: bigint;
    shares: bigint;
    fee: bigint;
  }> = [];
  for (const log of logs) {
    if (log.address !== input.marketAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = amm.parseLog(log);
    } catch {
      continue;
    }
    if (
      !parsed ||
      String(parsed.args.buyer).toLowerCase() !== input.owner.toLowerCase() ||
      Number(parsed.args.outcomeIndex) !== input.outcomeIndex
    )
      continue;
    matched.push({
      log,
      investment: BigInt(parsed.args.investmentAmount),
      shares: BigInt(parsed.args.outcomeTokensBought),
      fee: BigInt(parsed.args.feeAmount),
    });
  }
  if (matched.length !== 1) return null;
  const fill = matched[0];
  if (!fill) return null;
  const netShares = tokenNet(
    logs,
    input.positionContract,
    input.owner,
    input.tokenId,
  );
  if (
    fill.investment <= fill.fee ||
    fill.shares <= 0n ||
    netShares !== fill.shares
  )
    return null;
  return {
    canonicalPurchaseKey: `limitless:amm:${input.chainId}:${input.txHash.toLowerCase()}:${input.tokenId}:${fill.log.index}`,
    instrument: input.instrument,
    owner: input.owner.toLowerCase(),
    notionalRaw: fill.investment - fill.fee,
    grossSharesRaw: fill.shares,
    netSharesRaw: netShares,
    collateralDecimals: 6,
    shareDecimals: 6,
    feesUsdRaw: fill.fee,
    purchasedAt: input.purchasedAt,
    evidenceIds: [
      `${input.chainId}:${input.txHash.toLowerCase()}:${fill.log.index}`,
    ],
  };
}

/** Exact owner deltas from finalized Solana RPC. Requested amounts are never used. */
export function parseSolanaBuyEvidence(input: {
  transaction: unknown;
  signature: string;
  initiatingSignature: string;
  owner: string;
  collateralMint: string;
  outcomeMint: string;
  instrument: VerifiedBuyFacts["instrument"];
  grossNotionalRaw?: bigint;
  grossSharesRaw?: bigint;
  evidenceId?: string;
  settlementTransactions?: Array<{ signature: string; transaction: unknown }>;
}): VerifiedPurchaseEvidence | null {
  const row = input.transaction;
  if (
    !isRecord(row) ||
    !isRecord(row.meta) ||
    row.meta.err !== null ||
    !isRecord(row.transaction) ||
    !Array.isArray(row.transaction.signatures) ||
    row.transaction.signatures[0] !== input.signature ||
    !Number.isSafeInteger(row.blockTime)
  )
    return null;
  if (
    input.signature !== input.initiatingSignature ||
    !isRecord(row.transaction.message) ||
    !Array.isArray(row.transaction.message.accountKeys) ||
    !row.transaction.message.accountKeys.some(
      (key) =>
        isRecord(key) && key.signer === true && key.pubkey === input.owner,
    )
  )
    return null;
  const deltas = new Map<string, { raw: bigint; decimals: number }>();
  const observations = [
    { signature: input.signature, transaction: input.transaction },
    ...(input.settlementTransactions ?? []),
  ];
  const observedSignatures = new Set<string>();
  for (const observed of observations) {
    if (observedSignatures.has(observed.signature)) continue;
    observedSignatures.add(observed.signature);
    const observedRow = observed.transaction;
    if (
      !isRecord(observedRow) ||
      !isRecord(observedRow.meta) ||
      observedRow.meta.err !== null ||
      !isRecord(observedRow.transaction) ||
      !Array.isArray(observedRow.transaction.signatures) ||
      observedRow.transaction.signatures[0] !== observed.signature
    )
      return null;
    for (const [key, sign] of [
      ["preTokenBalances", -1n],
      ["postTokenBalances", 1n],
    ] as const) {
      const balances = observedRow.meta[key];
      if (!Array.isArray(balances)) return null;
      const accounts = new Set<number>();
      for (const balance of balances) {
        if (
          !isRecord(balance) ||
          balance.owner !== input.owner ||
          typeof balance.mint !== "string"
        )
          continue;
        if (
          !isRecord(balance.uiTokenAmount) ||
          !/^\d+$/.test(String(balance.uiTokenAmount.amount)) ||
          !Number.isSafeInteger(balance.uiTokenAmount.decimals) ||
          !Number.isSafeInteger(balance.accountIndex)
        )
          return null;
        const accountIndex = Number(balance.accountIndex);
        if (accounts.has(accountIndex)) return null;
        accounts.add(accountIndex);
        const decimals = Number(balance.uiTokenAmount.decimals);
        const current = deltas.get(balance.mint);
        if (current && current.decimals !== decimals) return null;
        deltas.set(balance.mint, {
          decimals,
          raw:
            (current?.raw ?? 0n) +
            sign * BigInt(String(balance.uiTokenAmount.amount)),
        });
      }
    }
  }
  const collateral = deltas.get(input.collateralMint),
    outcome = deltas.get(input.outcomeMint);
  if (!collateral || collateral.raw >= 0n || !outcome || outcome.raw <= 0n)
    return null;
  // Async fee splitting requires exact provider fill quantities. For sync RPC,
  // the debit cannot distinguish gross notional from platform fees, so no guess.
  if (
    input.grossNotionalRaw === undefined ||
    input.grossSharesRaw === undefined ||
    input.grossNotionalRaw <= 0n ||
    input.grossNotionalRaw > -collateral.raw ||
    input.grossSharesRaw < outcome.raw
  )
    return null;
  return {
    canonicalPurchaseKey: `dflow:mainnet:${input.initiatingSignature}:${input.owner}`,
    instrument: input.instrument,
    owner: input.owner,
    notionalRaw: input.grossNotionalRaw,
    grossSharesRaw: input.grossSharesRaw,
    netSharesRaw: outcome.raw,
    collateralDecimals: collateral.decimals,
    shareDecimals: outcome.decimals,
    feesUsdRaw: -collateral.raw - input.grossNotionalRaw,
    purchasedAt: new Date(Number(row.blockTime) * 1000).toISOString(),
    evidenceIds: [...observedSignatures]
      .map((signature) => `solana:mainnet:${signature}`)
      .concat(input.evidenceId ? [input.evidenceId] : []),
  };
}

export function combinePurchaseEvidence(
  parts: VerifiedPurchaseEvidence[],
): VerifiedBuyFacts | null {
  const first = parts[0];
  if (!first) return null;
  const ids = new Set<string>();
  for (const part of parts) {
    if (
      part.canonicalPurchaseKey !== first.canonicalPurchaseKey ||
      part.owner !== first.owner ||
      JSON.stringify(part.instrument) !== JSON.stringify(first.instrument) ||
      part.collateralDecimals !== first.collateralDecimals ||
      part.shareDecimals !== first.shareDecimals
    )
      return null;
    for (const id of part.evidenceIds) {
      if (ids.has(id)) return null;
      ids.add(id);
    }
  }
  return factsFromEvidence({
    ...first,
    notionalRaw: parts.reduce((sum, part) => sum + part.notionalRaw, 0n),
    grossSharesRaw: parts.reduce((sum, part) => sum + part.grossSharesRaw, 0n),
    netSharesRaw: parts.reduce((sum, part) => sum + part.netSharesRaw, 0n),
    feesUsdRaw: parts.some((part) => part.feesUsdRaw === null)
      ? null
      : parts.reduce((sum, part) => sum + (part.feesUsdRaw ?? 0n), 0n),
    purchasedAt: parts.reduce(
      (earliest, part) =>
        part.purchasedAt < earliest ? part.purchasedAt : earliest,
      first.purchasedAt,
    ),
    evidenceIds: [...ids],
  });
}
