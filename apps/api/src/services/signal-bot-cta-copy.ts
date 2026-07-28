function formatCents(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}¢`;
}

export function formatVenueLabel(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "polymarket":
      return "Poly";
    case "kalshi":
      return "Kalshi";
    case "limitless":
      return "Limitless";
    default:
      return value?.trim() || null;
  }
}

export function formatSignalBotBuyButtonText(input: {
  channel: boolean;
  price: number | null;
  side: "NO" | "YES";
  sideLabel: string;
  useNativeMarker: boolean;
  venue: string | null;
}): string {
  const price = input.price == null ? null : formatCents(input.price);
  if (input.channel) {
    return `Buy ${input.sideLabel} on Hunch${price ? ` · ${price}` : ""}`;
  }
  const marker = input.side === "YES" ? "🟠" : "⚪";
  const venue = formatVenueLabel(input.venue);
  const marketLabel =
    venue && price ? `${venue} ${price}` : (venue ?? price ?? null);
  return `${input.useNativeMarker ? `${marker} ` : ""}Buy ${input.sideLabel}${marketLabel ? ` · ${marketLabel}` : ""}`;
}

export function formatSignalBotCheaperButtonText(input: {
  alternative: { price: number; venue: string };
  sideLabel: string;
  useNativeMarker: boolean;
}): string {
  const venue =
    formatVenueLabel(input.alternative.venue) ?? input.alternative.venue;
  return `${input.useNativeMarker ? "💸 " : ""}Cheaper: ${venue} ${input.sideLabel} ${formatCents(input.alternative.price)}`;
}

export function formatSignalBotOpenButtonText(): string {
  return "Open on Hunch";
}
