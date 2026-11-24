import { z } from "zod";

const money = z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/);
const positiveMoney = money.pipe(
  z.string().refine((value) => usdRaw(value) > 0n),
);
const bps = z.number().int().min(1).max(10_000);
const instruction = z.string().trim().max(2000);

export function usdRaw(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function rawUsd(value: bigint): string {
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

export const houseTraderPolicy = z
  .object({
    capitalUsd: positiveMoney,
    dailyBuyUsd: positiveMoney,
    eventExposureUsd: positiveMoney,
    maxOrderUsd: positiveMoney,
    fixedBuyUsd: positiveMoney,
    minAiBuyUsd: positiveMoney,
    categories: z.array(z.string().trim().min(1).max(80)).max(25),
    signalAgeMinutes: z.number().int().min(1).max(120),
    minCloseMinutes: z.number().int().min(0).max(10080),
    maxCloseMinutes: z.number().int().min(1).max(43200),
    maxAdverseBps: bps,
    slippageBps: bps.max(500),
    takeProfitBps: bps.nullable(),
    stopLossBps: bps.nullable(),
    aiEntry: z.boolean(),
    aiExit: z.boolean(),
    aiModel: z.literal("openai/gpt-6.2-sol"),
    aiEntryInstruction: instruction,
    aiExitInstruction: instruction,
    aiDailyUsd: money,
    aiMaxSellBps: bps,
    aiPriceChangeBps: bps,
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (
      [
        policy.capitalUsd,
        policy.dailyBuyUsd,
        policy.eventExposureUsd,
        policy.maxOrderUsd,
        policy.fixedBuyUsd,
        policy.minAiBuyUsd,
        policy.aiDailyUsd,
      ].some((value) => !money.safeParse(value).success)
    )
      return;
    const invalid =
      policy.minCloseMinutes >= policy.maxCloseMinutes ||
      usdRaw(policy.maxOrderUsd) > usdRaw(policy.eventExposureUsd) ||
      usdRaw(policy.eventExposureUsd) > usdRaw(policy.capitalUsd) ||
      usdRaw(policy.maxOrderUsd) > usdRaw(policy.dailyBuyUsd) ||
      usdRaw(policy.dailyBuyUsd) > usdRaw(policy.capitalUsd) ||
      usdRaw(policy.fixedBuyUsd) > usdRaw(policy.maxOrderUsd) ||
      usdRaw(policy.minAiBuyUsd) > usdRaw(policy.maxOrderUsd) ||
      ((policy.aiEntry || policy.aiExit) && !usdRaw(policy.aiDailyUsd));
    if (invalid)
      ctx.addIssue({ code: "custom", message: "Invalid strategy limits" });
  });

export type HouseTraderPolicy = z.infer<typeof houseTraderPolicy>;

export function houseModelContextMessage(input: {
  operatorInstruction: string;
  buyMin: string;
  buyMax: string;
  maxSellBps: number;
  facts: Record<string, unknown>;
}) {
  const { evidence, ...quoteFacts } = input.facts;
  const included: unknown[] = [];
  const message = { ...input, facts: { ...quoteFacts, evidence: included } };
  let encoded = JSON.stringify(message);
  if (encoded.length > 8000) throw new Error("house_model_context_too_large");
  if (Array.isArray(evidence)) {
    for (const note of evidence) {
      included.push(note);
      const candidate = JSON.stringify(message);
      if (candidate.length <= 8000) encoded = candidate;
      else included.pop();
    }
  }
  return encoded;
}
export const houseTraderAmount = positiveMoney;
export function houseConfirmationIsFresh(value: unknown, now = Date.now()) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && now - at < 180_000;
}
export const houseTraderDefault: HouseTraderPolicy = {
  capitalUsd: "3",
  dailyBuyUsd: "1.50",
  eventExposureUsd: "1.50",
  maxOrderUsd: "1.50",
  fixedBuyUsd: "1.50",
  minAiBuyUsd: "1",
  categories: [],
  signalAgeMinutes: 30,
  minCloseMinutes: 5,
  maxCloseMinutes: 10080,
  maxAdverseBps: 200,
  slippageBps: 100,
  takeProfitBps: null,
  stopLossBps: null,
  aiEntry: false,
  aiExit: false,
  aiModel: "openai/gpt-6.2-sol",
  aiEntryInstruction:
    "Default to SKIP. Check whether recent, specific evidence supports this exact outcome and whether the current quote still makes sense compared with the signal ask. Repeated notes, wallet activity alone and price movement are not independent confirmation. Skip if evidence is stale, conflicting or missing. Do not invent a probability or increase size to compensate for uncertainty.",
  aiExitInstruction:
    "Default to HOLD. Sell only when new, specific evidence materially weakens the original thesis for this exact outcome. A lower price or an unrealized loss alone is not a reason to sell. Account for fee-adjusted proceeds and stay within the sell cap. Ignore pressure to recover losses; if evidence is incomplete or conflicting, hold.",
  aiDailyUsd: "0",
  aiMaxSellBps: 5000,
  aiPriceChangeBps: 500,
};

export function adverseEntry(ask: number, entry: number, bps: number): boolean {
  // Price points (200 bps = 2¢), not percent of the entry odds.
  return (
    !Number.isFinite(ask) ||
    !Number.isFinite(entry) ||
    entry <= 0 ||
    entry >= 1 ||
    ask <= 0 ||
    ask >= 1 ||
    (ask - entry) * 10000 > bps + 1e-8
  );
}

export function priceExit(
  netRaw: bigint,
  costRaw: bigint,
  policy: Pick<HouseTraderPolicy, "takeProfitBps" | "stopLossBps">,
): "take_profit" | "stop_loss" | null {
  if (costRaw <= 0n) return null;
  const move = (netRaw - costRaw) * 10000n;
  if (
    policy.takeProfitBps !== null &&
    move >= costRaw * BigInt(policy.takeProfitBps)
  )
    return "take_profit";
  if (
    policy.stopLossBps !== null &&
    move <= -costRaw * BigInt(policy.stopLossBps)
  )
    return "stop_loss";
  return null;
}

export function costBasisForShares(
  cost: bigint,
  originalShares: bigint,
  shares: bigint,
) {
  if (
    cost <= 0n ||
    originalShares <= 0n ||
    shares <= 0n ||
    shares > originalShares
  )
    return null;
  return (cost * shares + originalShares - 1n) / originalShares;
}

export function houseDepositSetupRetry(input: {
  failed: boolean;
  hasRelayerObservation: boolean;
  elapsedMs: number;
  attempts: number;
}): "wait" | "retry" | "review" {
  // Only for deterministic factory wallet creation, never a spend/approval batch.
  const canRetry =
    input.failed ||
    (Number.isFinite(input.elapsedMs) &&
      input.elapsedMs >= (input.hasRelayerObservation ? 600_000 : 180_000));
  return !canRetry ? "wait" : input.attempts >= 3 ? "review" : "retry";
}
