import type { JsonObject, JsonValue, Money } from "./types.js";

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMoneyJson(value: JsonObject | null): Money | null {
  if (!value || typeof value.raw !== "string") return null;
  const asset = value.asset;
  if (!isJsonObject(asset)) return null;
  const networkId = asset.networkId;
  const assetId = asset.assetId;
  const decimals = asset.decimals;
  if (
    typeof networkId !== "string" ||
    typeof assetId !== "string" ||
    typeof decimals !== "number"
  ) {
    return null;
  }
  return {
    asset: { networkId, assetId, decimals },
    raw: value.raw,
  };
}
