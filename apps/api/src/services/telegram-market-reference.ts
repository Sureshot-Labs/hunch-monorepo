import { HUNCH_VENUES } from "@hunch/shared";

/** Navigation identity is broader than bot execution capability. */
export function normalizeTelegramMarketRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (HUNCH_VENUES.some((venue) => trimmed.startsWith(`${venue}:`)))
    return trimmed;
  try {
    const url = new URL(trimmed);
    const marketParam = url.searchParams.get("market")?.trim();
    if (marketParam) return marketParam;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const marketIndex = pathParts.findIndex((part) => part === "markets");
    if (marketIndex >= 0 && pathParts[marketIndex + 1])
      return decodeURIComponent(pathParts[marketIndex + 1]);
    return pathParts.at(-1) ? decodeURIComponent(pathParts.at(-1) ?? "") : null;
  } catch {
    return trimmed;
  }
}

export function readTelegramMarketLinkSide(input: string): "YES" | "NO" | null {
  try {
    const side = new URL(input.trim()).searchParams.get("side");
    return side === "YES" || side === "NO" ? side : null;
  } catch {
    return null;
  }
}
