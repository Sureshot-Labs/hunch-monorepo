import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

/** Historical orders without context stay in the existing CTF namespace.
 * An explicit different/invalid ledger never silently falls back to CTF.
 * Callers pass a fixed SQL alias, not a user-supplied identifier.
 */
export function polymarketOrderStorageContractSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("Invalid order SQL alias.");
  const legacy = POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase();
  const ledger = `lower(coalesce(nullif(${alias}.order_payload->'assetContext'->>'positionContract', ''), '${legacy}'))`;
  return `(case when ${alias}.venue = 'polymarket' and ${ledger} <> '${legacy}' then ${ledger} else '' end)`;
}
