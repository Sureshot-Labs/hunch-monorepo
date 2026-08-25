import {
  addUnsignedDecimals,
  parseUnsignedDecimal,
} from "../account-value/decimal.js";
import type { AccountValueReadModel } from "../account-value/runtime-service.js";
import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
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

const TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET = 3_900;

type AccountComponent =
  AccountValueReadModel["projection"]["components"][number];

type GroupedWalletBalance = {
  amountRaw: bigint;
  availableKnownCount: number;
  availableRaw: bigint;
  availableUnknownCount: number;
  cashComponentCount: number;
  decimals: number;
  estimatedKnownCount: number;
  estimatedUnknownCount: number;
  estimatedUsd: string;
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

function assetSymbol(component: AccountComponent): string | null {
  return resolveKnownAccountAssetSymbol(component.amount.asset);
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

function locationDetail(
  component: AccountComponent,
  key: string,
): string | null {
  const value = component.location.details[key];
  return typeof value === "string" ? value : null;
}

function isPolymarketSafeFunder(component: AccountComponent): boolean {
  return (
    component.location.kind === "venue_account" &&
    component.category === "cash" &&
    locationDetail(component, "venueId") === "polymarket" &&
    locationDetail(component, "polymarketFunderKind") === "safe"
  );
}

function hasPolymarketDepositWallet(account: AccountValueReadModel): boolean {
  return account.projection.components.some(
    (component) =>
      component.location.kind === "venue_account" &&
      locationDetail(component, "venueId") === "polymarket" &&
      locationDetail(component, "polymarketFunderKind") === "deposit_wallet",
  );
}

function isNonRoutableLegacyPolymarketSafe(
  account: AccountValueReadModel,
  component: AccountComponent,
): boolean {
  return (
    hasPolymarketDepositWallet(account) && isPolymarketSafeFunder(component)
  );
}

function venueTradingBalance(input: {
  account: AccountValueReadModel;
  venueId: "polymarket" | "limitless";
}): Readonly<{ legacyUsd: string; routableUsd: string }> {
  const componentById = new Map(
    input.account.projection.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  const routable: string[] = [];
  const legacy: string[] = [];
  for (const availability of input.account.cashAvailability.components) {
    if (availability.venueId !== input.venueId) continue;
    const component = componentById.get(availability.componentId);
    if (!component) continue;
    const value = availability.availableEstimatedUsd;
    if (value == null) continue;
    if (isNonRoutableLegacyPolymarketSafe(input.account, component)) {
      legacy.push(value);
    } else {
      routable.push(value);
    }
  }
  return {
    legacyUsd: addUnsignedDecimals(legacy),
    routableUsd: addUnsignedDecimals(routable),
  };
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

export function formatTelegramAccountValueUsd(value: string): string {
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

function componentNeedsVisibility(component: AccountComponent): boolean {
  return (
    component.observationFreshness !== "fresh" ||
    component.valuationEligibility !== "included"
  );
}

function componentIsStale(component: AccountComponent): boolean {
  return (
    component.observationFreshness !== "fresh" ||
    component.valuationEligibility === "stale"
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
    const cashAvailabilityApplies = component.category === "cash";
    const availabilityKnown =
      !cashAvailabilityApplies || availabilityIsKnown(available);
    const raw = parseRaw(component.amount.raw);
    if (
      raw === 0n &&
      !componentNeedsVisibility(component) &&
      availabilityKnown
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
      cashComponentCount: 0,
      decimals,
      estimatedKnownCount: 0,
      estimatedUnknownCount: 0,
      estimatedUsd: "0",
      freshness: "fresh",
      network,
      symbol,
    };
    current.amountRaw += raw;
    if (component.estimatedUsd) {
      current.estimatedKnownCount += 1;
      current.estimatedUsd = addUnsignedDecimals([
        current.estimatedUsd,
        component.estimatedUsd.value,
      ]);
    } else {
      current.estimatedUnknownCount += 1;
    }
    if (cashAvailabilityApplies) {
      current.cashComponentCount += 1;
      if (availabilityIsKnown(available)) {
        current.availableKnownCount += 1;
        current.availableRaw += parseRaw(available?.availableRaw ?? "0");
      } else {
        current.availableUnknownCount += 1;
      }
    }
    if (
      componentIsStale(component) ||
      (cashAvailabilityApplies && !availabilityIsKnown(available))
    ) {
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
      const stale = componentIsStale(component) ? " · stale" : "";
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
  const availabilityByComponent = new Map(
    account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  const stale =
    account.projection.valuationFreshness === "stale" ||
    account.projection.positionValuationFreshness === "stale" ||
    account.projection.components.some((component) => {
      if (!isPublicComponent(component)) return false;
      return (
        componentIsStale(component) ||
        (component.category === "cash" &&
          !availabilityIsKnown(
            availabilityByComponent.get(component.componentId),
          ))
      );
    });
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
      ? "Known cash holdings · partial"
      : "Cash holdings";
  const portfolioPartial =
    account.projection.valuationCompleteness === "partial" ||
    account.projection.positionValuationCompleteness === "partial";
  const lines: string[] = [
    `💰 ${formatTelegramBoldMarkdownV2("Balance")}`,
    "",
    formatTelegramFieldMarkdownV2(
      headlineLabel,
      formatTelegramAccountValueUsd(account.headline.estimatedUsd),
    ),
    formatTelegramFieldMarkdownV2(
      cashLabel,
      formatTelegramAccountValueUsd(
        account.cashAvailability.cashAvailableEstimatedUsd,
      ),
    ),
  ];
  if (account.headline.mode !== "liquid_plus_positions") {
    lines.push(
      formatTelegramFieldMarkdownV2(
        portfolioPartial ? "Known portfolio value" : "Portfolio value",
        formatTelegramAccountValueUsd(
          account.projection.totalPortfolioEstimatedUsd,
        ),
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
    const trading = venueTradingBalance({ account, venueId });
    const routable = `${formatTelegramAccountValueUsd(trading.routableUsd)} ${
      account.cashAvailability.completeness === "partial"
        ? "known routable · partial"
        : "routable"
    }`;
    const legacy =
      trading.legacyUsd === "0"
        ? null
        : `${formatTelegramAccountValueUsd(trading.legacyUsd)} legacy wallet`;
    const portfolio = `${formatTelegramAccountValueUsd(
      venue?.totalPortfolioEstimatedUsd ?? "0",
    )} ${portfolioPartial ? "known portfolio" : "portfolio"}`;
    lines.push(
      escapeTelegramMarkdownV2(
        `• ${venueLabel(venueId)} — ${[routable, legacy, portfolio].filter(Boolean).join(" · ")}`,
      ),
    );
  }

  appendBoundedSection(lines, {
    heading: "In transit",
    omissionLabel: (count) => `… ${count} more transfers in transit`,
    prelude: [
      formatTelegramFieldMarkdownV2(
        "Estimated value",
        formatTelegramAccountValueUsd(account.projection.inTransitEstimatedUsd),
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
    const estimate =
      group.symbol !== "SOL" ||
      group.amountRaw === 0n ||
      group.estimatedKnownCount === 0
        ? ""
        : group.estimatedUnknownCount > 0
          ? ` · known ≈ ${formatTelegramAccountValueUsd(group.estimatedUsd)}`
          : ` · ≈ ${formatTelegramAccountValueUsd(group.estimatedUsd)}`;
    const available =
      group.cashComponentCount === 0
        ? ""
        : group.availableUnknownCount > 0
          ? group.availableKnownCount > 0
            ? ` · ${formatRaw(group.availableRaw, group.decimals)} known available · partial`
            : " · availability unknown"
          : ` · ${formatRaw(group.availableRaw, group.decimals)} available`;
    const stale = group.freshness === "stale" ? " · stale" : "";
    return escapeTelegramMarkdownV2(
      `• ${group.network} wallet — ${formatRaw(
        group.amountRaw,
        group.decimals,
      )} ${group.symbol}${estimate}${available}${stale}`,
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
  formatUsd: formatTelegramAccountValueUsd,
  networkLabel,
  textBudget: TELEGRAM_ACCOUNT_VALUE_TEXT_BUDGET,
};
