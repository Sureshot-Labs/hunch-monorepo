import type { Pool } from "@hunch/infra";

type Queryable = Pick<Pool, "query">;

/**
 * A direct pUSD receipt is venue-ready once its canonical receipt is ready.
 * Routed controller-wallet funding is reconciled by its own Relay operation;
 * a Deposit Wallet is never treated as a source for a Hunch Router operation.
 */
export async function hasReadyPolymarketDirectDestinationReceipt(
  db: Queryable,
  contextId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    `
      select exists (
        select 1
        from telegram_funding_sessions funding_context
        join funding_receive_sessions receive_session
          on receive_session.id = funding_context.receive_session_id
         and receive_session.user_id = funding_context.user_id
         and receive_session.owner_channel =
               funding_context.receive_owner_channel
        join telegram_funding_consents funding_consent
          on funding_consent.telegram_funding_session_id = funding_context.id
         and funding_consent.revision =
               funding_context.active_consent_revision
        join funding_receive_receipts receipt
          on receipt.receive_session_id = receive_session.id
         and receipt.user_id = funding_context.user_id
         and receipt.variant_id = any(funding_consent.consented_variant_ids)
        where funding_context.id = $1::uuid
          and receipt.status = 'ready'
          and receipt.handling = 'direct'
          and funding_receive_receipt_matches_frozen_variant(receipt)
          and receipt.network_id = receive_session.destination_asset->>'networkId'
          and receipt.asset_decimals =
                (receive_session.destination_asset->>'decimals')::int
          and funding_account_identifier_equal(
                receipt.network_id,
                receipt.asset_id,
                receive_session.destination_asset->>'assetId'
              )
          and receipt.network_id = funding_consent.selected_asset_network_id
          and receipt.asset_decimals = funding_consent.selected_asset_decimals
          and funding_account_identifier_equal(
                receipt.network_id,
                receipt.asset_id,
                funding_consent.selected_asset_id
              )
      ) as ready
    `,
    [contextId],
  );
  return rows[0]?.ready === true;
}
