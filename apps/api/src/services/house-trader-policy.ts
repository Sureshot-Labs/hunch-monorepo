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
export const houseTraderAmount = positiveMoney;
export function houseConfirmationIsFresh(value: unknown, now = Date.now()) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && now - at < 180_000;
}
export const houseTraderDefault: HouseTraderPolicy = {
  capitalUsd: "100",
  dailyBuyUsd: "10",
  eventExposureUsd: "5",
  maxOrderUsd: "2",
  fixedBuyUsd: "2",
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
  aiEntryInstruction: "",
  aiExitInstruction: "",
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
