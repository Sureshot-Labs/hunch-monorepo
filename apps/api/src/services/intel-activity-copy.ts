import { cleanPublicMarketText } from "./market-side-copy.js";

export const INTEL_ACTIVITY_COPY_VERSION = "intel_activity_v2";

/** Editorial rules only: never a publication, trading or freshness gate. */
export const INTEL_ACTIVITY_COPY_RULES = [
  "Write wallet-activity Intel, not a market-forecast headline. Lead with WHO is doing WHAT in the exact market, and a meaningful amount when supplied. Use the verified public display name; otherwise a trader or a factual group description. Never invent a handle or prepend @ to a display name.",
  "Headline: short, direct, conversational, normally 8-16 words and at most 140 characters. Preserve the exact selected outcome, threshold and event context before brevity. Prefer 'lava-lava holds $9.5K backing Likud to win 25–29 seats' over 'Likud could land in the 25–29-seat bracket'. Avoid 'Large position backs a different outcome', 'Smart money is making moves', and 'Interesting wallet activity detected'. Treat examples as style only, never as evidence.",
  "A holding snapshot supports holds or has a position, not bought, added, built, still refuses to sell or has not taken profit. Compare exact-wallet, exact-side share observations to describe an observed increase or reduction; unchanged shares do not exclude intervening trades. Use bought only for confirmed trade evidence. A new article, first observation, unsigned activity label or price-driven USD increase is not a purchase.",
  "Keep units and money basis explicit: positionValueUsd is marked holding value, not dollars spent; positionShares are shares, not dollars. A snapshot change valued at current prices is an estimated change in exposure, not trade proceeds. Open PnL is unrealized; approximate 30-day PnL may include open positions and is not realized profit. Negative overall performance must not become a profitable-trader claim through selective thematic statistics.",
  "The body explains WHY the activity is interesting without repeating the title: a verified track record with its sample/period, meaningful opposition, an observed position change or a relevant exact-contract fact. Do not invent motives, unusual conviction, total wealth or continuous holding. A profitable trader does not guarantee a smart trade. A holding can be interesting without a new purchase or catalyst.",
  "Use one or two concrete facts in natural sentences, not generic 'plausible outcome' or 'consistent with a possible win' filler. 'Holds' already describes a snapshot: do not routinely repeat 'this is not a new purchase' in the body. Keep that caveat only when the comparison could otherwise imply a purchase. If mentioning 30-day PnL, say approximate PnL including open positions, not simply 'up' or realized profits. Omit a secondary PnL number rather than lose its basis to the length limit.",
  "Do not include CTA text in headline, summary or caveats: no View market, View trader, Buy now or notification requests. Navigation and trading controls belong to the interface. Return plain semantic prose, not Markdown, emoji or a formatted card.",
] as const;

export function intelPublicActorName(
  value: string | null | undefined,
): string | null {
  const name = cleanPublicMarketText(value)?.trim();
  if (
    !name ||
    name.length > 80 ||
    /https?:\/\//i.test(name) ||
    /^(?:@?0x[0-9a-f]{40}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[1-9A-HJ-NP-Za-km-z]{32,44})$/i.test(
      name,
    ) ||
    /^(?:(?:a|the|tracked|trading|profitable|strong|unknown|anonymous|auto(?:matic)?|generated)\s+)*(?:trader|wallet)(?:\s*\((?:auto(?:matic)?|generated|unknown)\))?$/i.test(
      name,
    )
  )
    return null;
  return name;
}

export function intelHoldingObservation(input: {
  displayName: string | null;
  positionUsd: number | null;
  positionShares: number | null;
  observedAt: string | null;
}) {
  return {
    kind: "holding_snapshot" as const,
    displayName: intelPublicActorName(input.displayName),
    positionValueUsd: finiteNonNegative(input.positionUsd),
    positionShares: finiteNonNegative(input.positionShares),
    observedAt: input.observedAt,
    amountBasis: "marked_position_value_not_trade_notional" as const,
    confirmedPurchase: false,
    comparisonRule:
      "This record alone establishes holdings only. Use separately supplied exact-wallet/side share comparisons for changes; USD repricing alone is not accumulation.",
  };
}

function finiteNonNegative(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function usd(value: number): string {
  for (const [threshold, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const) {
    if (value >= threshold)
      return `$${(value / threshold).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  }
  return `$${value.toFixed(2).replace(/\.00$/, "")}`;
}

export type IntelActivityHeadlineInput = {
  actorName: string | null;
  actorMode: "none" | "single_holder" | "sharp_cluster" | null;
  actorCount: number;
  positionValueUsd: number | null;
  /** Complete selected-side proposition, already resolved by the market presenter. */
  positionLabel: string;
  change?: {
    scope: "representative_wallet" | "selected_side_cluster";
    beforeUsd: number;
    afterUsd: number;
    positionChangeUsd: number;
  } | null;
};

export function buildIntelActivityHeadline(
  input: IntelActivityHeadlineInput,
): string {
  const cluster = input.actorMode === "sharp_cluster";
  const count =
    Number.isSafeInteger(input.actorCount) && input.actorCount > 1
      ? input.actorCount
      : null;
  const actor = cluster
    ? count
      ? `${count} tracked wallets`
      : "Tracked wallets"
    : input.actorMode === "single_holder"
      ? (intelPublicActorName(input.actorName) ?? "A trader")
      : "Tracked holders";
  const plural = cluster || input.actorMode !== "single_holder";
  const position = (
    cleanPublicMarketText(input.positionLabel) ?? "the selected outcome"
  ).replace(/[.!?]+$/, "");
  const amount = finiteNonNegative(input.positionValueUsd);
  const change = input.change;
  // Never attribute aggregate movement to the representative holder (or vice versa).
  if (
    change &&
    ((cluster && change.scope === "selected_side_cluster") ||
      (input.actorMode === "single_holder" &&
        change.scope === "representative_wallet")) &&
    [change.beforeUsd, change.afterUsd].every(
      (value) => finiteNonNegative(value) != null,
    ) &&
    Number.isFinite(change.positionChangeUsd) &&
    change.positionChangeUsd !== 0
  ) {
    // selected_side_cluster is ALL tracked holders, not the sharp subset/count.
    const owner = cluster
      ? "Tracked holders’"
      : actor === "A trader"
        ? "A trader’s"
        : `${actor}${actor.endsWith("s") ? "’" : "’s"}`;
    return `${owner} position ${position} is now worth ${usd(change.afterUsd)} (${change.positionChangeUsd > 0 ? "up" : "down"} ${usd(Math.abs(change.positionChangeUsd))}).`;
  }
  return `${actor} ${plural ? "hold" : "holds"}${amount != null && amount > 0 ? ` ${usd(amount)}` : " a position"} ${position}.`;
}
