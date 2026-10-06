import { POLYMARKET_PROTOCOL_CONTRACTS } from "@hunch/shared";

export function buildHiddenOwnPositionSnapshotSuppressionSql(inputs: {
  snapshotAlias: string;
  walletAlias: string;
}): string {
  const { snapshotAlias, walletAlias } = inputs;
  if (
    ![snapshotAlias, walletAlias].every((alias) =>
      /^[a-z][a-z0-9_]*$/.test(alias),
    )
  )
    throw new Error("Invalid snapshot SQL alias.");
  const ledger = (expression: string) =>
    `(case when lower(coalesce(${expression}, '')) = '${POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase()}' then '' else lower(coalesce(${expression}, '')) end)`;
  const notHidden = (tokenSql: string, contractSql: string) => `not exists (
    select 1 from positions hp
    where hp.position_scope = 'own' and coalesce(hp.is_hidden, false) = true
      and hp.venue = ${snapshotAlias}.venue and hp.token_id = ${tokenSql}
      and hp.position_contract = ${ledger(contractSql)}
      and hp.wallet_address is not null and btrim(hp.wallet_address) <> ''
      and ((${walletAlias}.chain = 'solana' and hp.wallet_address = ${walletAlias}.address)
        or (${walletAlias}.chain <> 'solana' and lower(hp.wallet_address) = lower(${walletAlias}.address)))
  )`;
  const assetsSql = `jsonb_array_elements(case when jsonb_typeof(${snapshotAlias}.metadata->'assets') = 'array' then ${snapshotAlias}.metadata->'assets' else '[]'::jsonb end) held_asset`;
  const validAssetSql = `jsonb_typeof(held_asset) = 'object'
    and jsonb_typeof(held_asset->'tokenId') = 'string'
    and btrim(held_asset->>'tokenId') <> ''
    and (held_asset->'positionContract' is null or jsonb_typeof(held_asset->'positionContract') in ('string', 'null'))`;
  // metadata.tokenId can be the current price token, not the held ERC-1155.
  // A logical snapshot stays visible when any actual ledger-qualified asset is
  // visible. Old/malformed metadata keeps the historical single-token fallback.
  return `(case when ${snapshotAlias}.venue = 'polymarket'
    and exists (select 1 from ${assetsSql} where ${validAssetSql})
    then exists (
      select 1 from ${assetsSql}
      where ${validAssetSql} and ${notHidden("held_asset->>'tokenId'", "held_asset->>'positionContract'")}
    )
    else ${notHidden(`${snapshotAlias}.metadata->>'tokenId'`, `${snapshotAlias}.metadata->>'positionContract'`)} end)`;
}
