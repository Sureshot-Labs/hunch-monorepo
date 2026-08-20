import { isRecord } from "../lib/type-guards.js";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Limitless publishes the execution mode in several equivalent metadata
 * fields. Keep the interpretation in one pure helper: the Telegram handoff
 * selector and the venue executor must never disagree about AMM routing.
 */
export function isLimitlessAmmMarketMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const directFlags = [
    metadata.amm,
    metadata.isAmm,
    metadata.is_amm,
    metadata.ammOnly,
    metadata.amm_only,
  ];
  if (directFlags.some((value) => value === true)) return true;
  const mode =
    readString(metadata.executionMode) ??
    readString(metadata.execution_mode) ??
    readString(metadata.tradingMode) ??
    readString(metadata.trading_mode) ??
    readString(metadata.tradeType) ??
    readString(metadata.trade_type) ??
    readString(metadata.marketType) ??
    readString(metadata.market_type);
  return mode?.toLowerCase() === "amm";
}
