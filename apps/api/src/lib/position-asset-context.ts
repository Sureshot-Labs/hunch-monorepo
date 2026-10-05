import {
  parsePolymarketAssetContext,
  type PolymarketAssetContext,
} from "@hunch/shared";

/** The empty storage namespace preserves existing CTF/non-Polymarket rows.
 * The wire context always retains the real contract, including legacy CTF.
 * Never derive a stored holding's generation from the market's current IDs.
 */
export function positionStorageContract(inputs: {
  venue: string;
  tokenId: string;
  assetContext?: PolymarketAssetContext | null;
}): string {
  if (inputs.assetContext == null) return "";
  const context = parsePolymarketAssetContext(inputs.assetContext);
  if (
    inputs.venue !== "polymarket" ||
    context == null ||
    context.assetId !== inputs.tokenId
  )
    throw new Error("Position asset context does not match its holding.");
  return context.assetKind === "ctf"
    ? ""
    : context.positionContract.toLowerCase();
}

export function positionAssetKey(
  tokenId: string,
  positionContract = "",
): string {
  return `${positionContract.toLowerCase()}:${tokenId}`;
}
