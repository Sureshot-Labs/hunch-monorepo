export function buildWalletOwnerResolutionJoinSql(
  includeDetails = false,
  resultAlias: "owner" | "resolved_owner" = "owner",
): string {
  const linkedOwnerAddressSql = `
    coalesce(
      w.metadata->>'ownerAddress',
      w.metadata->>'linkedOwnerAddress'
    )
  `;
  const ownerColumns = includeDetails
    ? `
          w2.address as owner_address,
          w2.label as owner_label,
          w2.id as owner_wallet_id`
    : `
          w2.address as owner_address`;
  const resolvedColumns = includeDetails
    ? `
          coalesce(
            linked_owner_evm.owner_address,
            linked_owner_exact.owner_address,
            safe_owner.owner_address
          ) as owner_address,
          coalesce(
            linked_owner_evm.owner_label,
            linked_owner_exact.owner_label,
            safe_owner.owner_label
          ) as owner_label,
          coalesce(
            linked_owner_evm.owner_wallet_id,
            linked_owner_exact.owner_wallet_id,
            safe_owner.owner_wallet_id
          ) as owner_wallet_id`
    : `
          coalesce(
            linked_owner_evm.owner_address,
            linked_owner_exact.owner_address,
            safe_owner.owner_address
          ) as owner_address`;

  return `
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where w.chain <> 'solana'
                  and ${linkedOwnerAddressSql} ~* '^0x[0-9a-f]{40}$'
                  and w2.chain <> 'solana'
                  and w2.chain = w.chain
                  and lower(w2.address) = lower(${linkedOwnerAddressSql})
                limit 1
              ) linked_owner_evm on true
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where ${linkedOwnerAddressSql} is not null
                  and (
                    w.chain = 'solana'
                    or ${linkedOwnerAddressSql} !~* '^0x[0-9a-f]{40}$'
                  )
                  and w2.chain = w.chain
                  and w2.address = ${linkedOwnerAddressSql}
                limit 1
              ) linked_owner_exact on true
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where linked_owner_evm.owner_address is null
                  and linked_owner_exact.owner_address is null
                  and w.metadata->>'kind' = 'safe'
                  and w2.chain = w.chain
                  and w2.metadata->>'kind' = 'safe_owner'
                  and w2.metadata->>'derivedFrom' = w.address
                limit 1
              ) safe_owner on true
              left join lateral (
                select${resolvedColumns}
              ) "${resultAlias}" on true`;
}
