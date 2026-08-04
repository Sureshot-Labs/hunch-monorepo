import { parseUnsignedDecimal } from "../account-value/decimal.js";
import type { AccountValueReadModel } from "../account-value/runtime-service.js";
import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import {
  buildTelegramAccountValueKeyboard,
  buildTelegramAccountValueUnavailableMessage,
} from "./telegram-account-value-contract.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramFieldMarkdownV2,
  formatTelegramItalicMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";

const SOLANA_NATIVE_ASSET_ID = "11111111111111111111111111111111";
const TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET = 3_900;

type AccountComponent =
  AccountValueReadModel["projection"]["components"][number];

type GroupedWalletBalance = {
  amountRaw: bigint;
  availableKnownCount: number;
  availableRaw: bigint;
  availableUnknownCount: number;
  decimals: number;
  freshness: "fresh" | "stale";
  network: string;
  symbol: string;
};

type GroupedRestriction = {
  decimals: number;
  label: string;
  lockedRaw: bigint;
  reservedRaw: bigint;
  submittedDebitRaw: bigint;
  symbol: string;
};

type InTransitBalance = {
  componentId: string;
  label: string;
};

type BoundedSection = Readonly<{
  heading: string;
  omissionLabel: (count: number) => string;
  prelude?: readonly string[];
  rows: readonly string[];
}>;

function normalizedAssetId(value: string): string {
  return /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
}

function assetSymbol(component: AccountComponent): string | null {
  const asset = component.amount.asset;
  const assetId = normalizedAssetId(asset.assetId);
  if (
    assetId ===
    normalizedAssetId(fundingSidecarRuntimeConfig.polymarketPusdAddress)
  ) {
    return "pUSD";
  }
  if (
    assetId ===
    normalizedAssetId(fundingSidecarRuntimeConfig.polymarketUsdceAddress)
  ) {
    return "USDC.e";
  }
  if (
    assetId ===
      normalizedAssetId(fundingSidecarRuntimeConfig.limitlessUsdcAddress) ||
    assetId === fundingSidecarRuntimeConfig.solanaUsdcMint
  ) {
    return "USDC";
  }
  if (
    asset.networkId === "solana:mainnet" &&
    assetId === SOLANA_NATIVE_ASSET_ID
  ) {
    return "SOL";
  }
  return null;
}

function networkLabel(networkId: string): string {
  if (networkId === "evm:137") return "Polygon";
  if (networkId === "evm:8453") return "Base";
  if (networkId === "solana:mainnet") return "Solana";
  return "Other network";
}

function venueLabel(venueId: string | null | undefined): string | null {
  if (venueId === "polymarket") return "Polymarket";
  if (venueId === "limitless") return "Limitless";
  if (venueId === "kalshi") return "Kalshi";
  return null;
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatRaw(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return "—";
  const digits = raw.toString().padStart(decimals + 1, "0");
  const integer = decimals === 0 ? digits : digits.slice(0, -decimals) || "0";
  const fraction =
    decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/u, "");
  const grouped = groupDigits(integer);
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function parseRaw(value: string): bigint {
  return /^(0|[1-9]\d*)$/u.test(value) ? BigInt(value) : 0n;
}

function formatUsd(value: string): string {
  try {
    if (value.length > 256) return "$—";
    const parsed = parseUnsignedDecimal(value);
    if (parsed.scale > 36) return "$—";
    const cents =
      parsed.scale <= 2
        ? parsed.coefficient * 10n ** BigInt(2 - parsed.scale)
        : (() => {
            const divisor = 10n ** BigInt(parsed.scale - 2);
            return (parsed.coefficient + divisor / 2n) / divisor;
          })();
    const whole = groupDigits((cents / 100n).toString());
    const fraction = (cents % 100n).toString().padStart(2, "0");
    return `$${whole}.${fraction}`;
  } catch {
    return "$—";
  }
}

function formatAsOf(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "time unavailable";
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function isPublicComponent(component: AccountComponent): boolean {
  return component.valuationEligibility !== "excluded";
}

function componentIsDegraded(component: AccountComponent): boolean {
  return (
    component.observationFreshness !== "fresh" ||
    component.valuationEligibility !== "included"
  );
}

function availabilityIsKnown(
  availability:
    | AccountValueReadModel["cashAvailability"]["components"][number]
    | undefined,
): boolean {
  return (
    availability != null &&
    !availability.reasonCodes.includes("cash_availability_unknown")
  );
}

function buildWalletGroups(account: AccountValueReadModel): {
  known: GroupedWalletBalance[];
  unknown: Array<{ count: number; network: string }>;
} {
  const availability = new Map(
    account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  const groups = new Map<string, GroupedWalletBalance>();
  const unknown = new Map<string, number>();
  for (const component of account.projection.components) {
    if (
      !isPublicComponent(component) ||
      component.location.kind !== "wallet" ||
      component.category === "in_transit"
    ) {
      continue;
    }
    const available = availability.get(component.componentId);
    const raw = parseRaw(component.amount.raw);
    if (
      raw === 0n &&
      !componentIsDegraded(component) &&
      availabilityIsKnown(available)
    ) {
      continue;
    }
    const network = networkLabel(component.amount.asset.networkId);
    const symbol = assetSymbol(component);
    if (!symbol) {
      unknown.set(network, (unknown.get(network) ?? 0) + 1);
      continue;
    }
    const decimals = component.amount.asset.decimals;
    const key = `${component.amount.asset.networkId}:${component.amount.asset.assetId}:${decimals}`;
    const current = groups.get(key) ?? {
      amountRaw: 0n,
      availableKnownCount: 0,
      availableRaw: 0n,
      availableUnknownCount: 0,
      decimals,
      freshness: "fresh",
      network,
      symbol,
    };
    current.amountRaw += raw;
    if (availabilityIsKnown(available)) {
      current.availableKnownCount += 1;
      current.availableRaw += parseRaw(available?.availableRaw ?? "0");
    } else {
      current.availableUnknownCount += 1;
    }
    if (componentIsDegraded(component) || available?.freshness === "stale") {
      current.freshness = "stale";
    }
    groups.set(key, current);
  }
  return {
    known: [...groups.values()].sort((left, right) =>
      `${left.network}:${left.symbol}`.localeCompare(
        `${right.network}:${right.symbol}`,
      ),
    ),
    unknown: [...unknown.entries()]
      .map(([network, count]) => ({ count, network }))
      .sort((left, right) => left.network.localeCompare(right.network)),
  };
}

function buildRestrictionGroups(
  account: AccountValueReadModel,
): GroupedRestriction[] {
  const componentById = new Map(
    account.projection.components
      .filter(isPublicComponent)
      .map((component) => [component.componentId, component]),
  );
  const groups = new Map<string, GroupedRestriction>();
  for (const availability of account.cashAvailability.components) {
    const lockedRaw = parseRaw(availability.lockedRaw);
    const reservedRaw = parseRaw(availability.reservedRaw);
    const submittedDebitRaw = parseRaw(availability.submittedDebitRaw);
    if (lockedRaw + reservedRaw + submittedDebitRaw === 0n) continue;
    const component = componentById.get(availability.componentId);
    if (!component) continue;
    const symbol = assetSymbol(component);
    if (!symbol) continue;
    const label =
      venueLabel(availability.venueId) ??
      `${networkLabel(component.amount.asset.networkId)} wallet`;
    const decimals = component.amount.asset.decimals;
    const key = `${label}:${component.amount.asset.networkId}:${component.amount.asset.assetId}:${decimals}`;
    const current = groups.get(key) ?? {
      decimals,
      label,
      lockedRaw: 0n,
      reservedRaw: 0n,
      submittedDebitRaw: 0n,
      symbol,
    };
    current.lockedRaw += lockedRaw;
    current.reservedRaw += reservedRaw;
    current.submittedDebitRaw += submittedDebitRaw;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) =>
    `${left.label}:${left.symbol}`.localeCompare(
      `${right.label}:${right.symbol}`,
    ),
  );
}

function buildInTransitBalances(
  account: AccountValueReadModel,
): InTransitBalance[] {
  return account.projection.components
    .filter(
      (component) =>
        isPublicComponent(component) && component.category === "in_transit",
    )
    .map((component) => {
      const network = networkLabel(component.amount.asset.networkId);
      const symbol = assetSymbol(component);
      const stale = componentIsDegraded(component) ? " · stale" : "";
      const label = symbol
        ? `• ${network} ${symbol} — ${formatRaw(
            parseRaw(component.amount.raw),
            component.amount.asset.decimals,
          )} · in transit${stale}`
        : `• ${network} transfer — amount tracked · in transit${stale}`;
      return {
        componentId: component.componentId,
        label: escapeTelegramMarkdownV2(label),
      };
    })
    .sort((left, right) =>
      `${left.label}:${left.componentId}`.localeCompare(
        `${right.label}:${right.componentId}`,
      ),
    );
}

function buildStatusLines(account: AccountValueReadModel): string[] {
  const partial =
    account.projection.valuationCompleteness === "partial" ||
    account.projection.positionValuationCompleteness === "partial" ||
    account.cashAvailability.completeness === "partial";
  const stale =
    account.projection.valuationFreshness === "stale" ||
    account.projection.positionValuationFreshness === "stale" ||
    account.cashAvailability.freshness === "stale";
  const collectorErrorCount = new Set([
    ...account.projection.collectorErrors.map(
      (error) => `${error.collectorId}:${error.code}`,
    ),
    ...account.cashAvailability.collectorErrors.map(
      (error) => `${error.collectorId}:${error.code}`,
    ),
  ]).size;
  if (!partial && !stale && collectorErrorCount === 0) return [];
  const details: string[] = [];
  if (partial) details.push("Only currently known balances are shown.");
  if (stale) details.push("Some values are stale.");
  if (collectorErrorCount > 0) {
    details.push(
      `${collectorErrorCount} balance source${collectorErrorCount === 1 ? "" : "s"} could not refresh.`,
    );
  }
  const title = partial
    ? stale
      ? "Partial and stale data"
      : "Partial data"
    : "Stale data";
  return [
    "",
    formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: details.map(escapeTelegramMarkdownV2),
      icon: "⚠️",
      title,
    }),
  ];
}

function appendBoundedSection(lines: string[], section: BoundedSection): void {
  if (section.rows.length === 0) return;
  const prefix = [
    "",
    formatTelegramBoldMarkdownV2(section.heading),
    ...(section.prelude ?? []),
  ];
  const accepted: string[] = [];
  for (let index = 0; index < section.rows.length; index += 1) {
    const remaining = section.rows.length - index - 1;
    const omission =
      remaining > 0
        ? [escapeTelegramMarkdownV2(section.omissionLabel(remaining))]
        : [];
    const candidate = joinTelegramMarkdownV2Lines([
      ...lines,
      ...prefix,
      ...accepted,
      section.rows[index] ?? "",
      ...omission,
    ]);
    if (candidate.length > TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET) break;
    accepted.push(section.rows[index] ?? "");
  }
  const omitted = section.rows.length - accepted.length;
  const rendered = [
    ...prefix,
    ...accepted,
    ...(omitted > 0
      ? [escapeTelegramMarkdownV2(section.omissionLabel(omitted))]
      : []),
  ];
  if (
    joinTelegramMarkdownV2Lines([...lines, ...rendered]).length <=
    TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET
  ) {
    lines.push(...rendered);
  }
}

export { buildTelegramAccountValueUnavailableMessage };

export function buildTelegramAccountValueMessage(input: {
  account: AccountValueReadModel;
}): TelegramBotTradingClientMessage {
  const account = input.account;
  const walletGroups = buildWalletGroups(account);
  const restrictions = buildRestrictionGroups(account);
  const inTransit = buildInTransitBalances(account);
  const headlineLabel =
    account.headline.completeness === "partial"
      ? `Known ${account.headline.label.toLowerCase()}`
      : account.headline.label;
  const cashLabel =
    account.cashAvailability.completeness === "partial"
      ? "Known cash available · partial"
      : "Cash available";
  const portfolioPartial =
    account.projection.valuationCompleteness === "partial" ||
    account.projection.positionValuationCompleteness === "partial";
  const lines: string[] = [
    `💰 ${formatTelegramBoldMarkdownV2("Balance")}`,
    "",
    formatTelegramFieldMarkdownV2(
      headlineLabel,
      formatUsd(account.headline.estimatedUsd),
    ),
    formatTelegramFieldMarkdownV2(
      cashLabel,
      formatUsd(account.cashAvailability.cashAvailableEstimatedUsd),
    ),
  ];
  if (account.headline.mode !== "liquid_plus_positions") {
    lines.push(
      formatTelegramFieldMarkdownV2(
        portfolioPartial ? "Known portfolio value" : "Portfolio value",
        formatUsd(account.projection.totalPortfolioEstimatedUsd),
      ),
    );
  }
  lines.push(
    formatTelegramItalicMarkdownV2(
      `Updated ${formatAsOf(account.projection.asOf)}`,
    ),
    ...buildStatusLines(account),
    "",
    formatTelegramBoldMarkdownV2("Trading balances"),
  );
  for (const venueId of ["polymarket", "limitless"] as const) {
    const venue = account.venues[venueId];
    const available = `${formatUsd(venue?.cashAvailableEstimatedUsd ?? "0")} ${
      account.cashAvailability.completeness === "partial"
        ? "known available · partial"
        : "available"
    }`;
    const portfolio = `${formatUsd(
      venue?.totalPortfolioEstimatedUsd ?? "0",
    )} ${portfolioPartial ? "known portfolio" : "portfolio"}`;
    lines.push(
      escapeTelegramMarkdownV2(
        `• ${venueLabel(venueId)} — ${available} · ${portfolio}`,
      ),
    );
  }

  appendBoundedSection(lines, {
    heading: "In transit",
    omissionLabel: (count) => `… ${count} more transfers in transit`,
    prelude: [
      formatTelegramFieldMarkdownV2(
        "Estimated value",
        formatUsd(account.projection.inTransitEstimatedUsd),
      ),
    ],
    rows: inTransit.map((item) => item.label),
  });

  appendBoundedSection(lines, {
    heading: "Locked and reserved",
    omissionLabel: (count) => `… ${count} more restricted balances`,
    rows: restrictions.map((restriction) => {
      const parts = [
        restriction.lockedRaw > 0n
          ? `${formatRaw(restriction.lockedRaw, restriction.decimals)} locked`
          : null,
        restriction.reservedRaw > 0n
          ? `${formatRaw(restriction.reservedRaw, restriction.decimals)} reserved`
          : null,
        restriction.submittedDebitRaw > 0n
          ? `${formatRaw(
              restriction.submittedDebitRaw,
              restriction.decimals,
            )} submitted`
          : null,
      ].filter((part): part is string => part != null);
      return escapeTelegramMarkdownV2(
        `• ${restriction.label} ${restriction.symbol} — ${parts.join(" · ")}`,
      );
    }),
  });

  const walletRows = walletGroups.known.map((group) => {
    const available =
      group.availableUnknownCount > 0
        ? group.availableKnownCount > 0
          ? ` · ${formatRaw(group.availableRaw, group.decimals)} known available · partial`
          : " · availability unknown"
        : ` · ${formatRaw(group.availableRaw, group.decimals)} available`;
    const stale = group.freshness === "stale" ? " · stale" : "";
    return escapeTelegramMarkdownV2(
      `• ${group.network} wallet — ${formatRaw(
        group.amountRaw,
        group.decimals,
      )} ${group.symbol}${available}${stale}`,
    );
  });
  walletRows.push(
    ...walletGroups.unknown.map(({ count, network }) =>
      escapeTelegramMarkdownV2(
        `• ${network} — Other assets · ${count} balance${count === 1 ? "" : "s"} tracked`,
      ),
    ),
  );
  appendBoundedSection(lines, {
    heading: "Wallet balances",
    omissionLabel: (count) => `… ${count} more balances`,
    rows: walletRows,
  });

  const text = joinTelegramMarkdownV2Lines(lines);
  return {
    parse_mode: "MarkdownV2",
    reply_markup: buildTelegramAccountValueKeyboard(),
    text,
  };
}

export const telegramAccountValueTestHooks = {
  assetSymbol,
  formatRaw,
  formatUsd,
  networkLabel,
  textBudget: TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET,
};
