import type { Pool, PoolClient } from "@hunch/infra";

import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "../funding/execution/delegated-funding-profile-ids.js";
import { PolymarketFundingPredecessorUnresolvedError } from "../funding/preparation/polymarket-funding-commit-guard.js";
import type { FundingReceiveReceiptRoutingTarget } from "../funding/persistence/funding-receive-session-repository.js";
import type { FundingReceiveRoutingErrorDirective } from "../funding/receive/receive-receipt-router.js";

type Queryable = Pick<Pool, "query">;
const POLYMARKET_PREDECESSOR_RETRY_MS = 60_000;

export function classifyPolymarketFundingRoutingError(
  error: unknown,
): FundingReceiveRoutingErrorDirective | null {
  return error instanceof PolymarketFundingPredecessorUnresolvedError
    ? {
        errorCode: "routing_predecessor_unresolved",
        retryAfterMs: POLYMARKET_PREDECESSOR_RETRY_MS,
        retryMode: "defer_without_budget",
      }
    : null;
}

export async function validatePolymarketFundingOperationLink(
  client: PoolClient,
  input: Readonly<{
    operationId: string;
    target: FundingReceiveReceiptRoutingTarget;
    consentId: string;
    consentFingerprint: string;
    authorizationId: string;
    authorizationFingerprint: string;
  }>,
): Promise<boolean> {
  const { rows } = await client.query<{ valid: boolean }>(
    `
      select exists (
        select 1
        from funding_operations operation
        join funding_operation_steps step
          on step.operation_id = operation.id
         and step.ordinal = 0
        join funding_receive_receipts receipt
          on receipt.id = $3::uuid
         and receipt.receive_session_id = $4::uuid
         and receipt.user_id = operation.user_id
        join funding_receive_canonical_events canonical_event
          on canonical_event.allocated_receipt_id = receipt.id
         and canonical_event.allocated_receive_session_id =
               receipt.receive_session_id
         and canonical_event.allocation_status = 'allocated'
        join telegram_funding_sessions funding_context
          on funding_context.receive_session_id = receipt.receive_session_id
         and funding_context.user_id = operation.user_id
        join telegram_funding_consents funding_consent
          on funding_consent.id = $5::uuid
         and funding_consent.telegram_funding_session_id = funding_context.id
         and funding_consent.consent_fingerprint = $6
         and funding_consent.consented_at <= canonical_event.first_observed_at
         and funding_consent.automation_policy_snapshot ->> 'authorizationId' = $8
         and funding_consent.automation_policy_snapshot ->>
               'authorizationFingerprint' = $9
         and operation.policy_revision =
               funding_consent.automation_policy_snapshot ->> 'fundingPolicyRevision'
        where operation.id = $1::uuid
          and operation.user_id = $2::uuid
          and operation.support_metadata ->> 'preparationKind' =
                'polymarket_funding_router'
          and operation.requested_source_amount ->> 'raw' =
                receipt.raw_amount::text
          and step.executor_id = $7
          and step.state = 'planned'
      ) as valid
    `,
    [
      input.operationId,
      input.target.userId,
      input.target.receipt.receiptId,
      input.target.receipt.receiveSessionId,
      input.consentId,
      input.consentFingerprint,
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
      input.authorizationId,
      input.authorizationFingerprint,
    ],
  );
  return rows[0]?.valid === true;
}

export async function hasReadyPolymarketFundingDestinationReceipt(
  db: Queryable,
  contextId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    `
      select exists (
        select 1
        from telegram_funding_sessions context
        join funding_receive_sessions receive
          on receive.id = context.receive_session_id
         and receive.user_id = context.user_id
         and receive.owner_channel = context.receive_owner_channel
        join telegram_funding_consents consent
          on consent.telegram_funding_session_id = context.id
         and consent.revision = context.active_consent_revision
        join funding_receive_receipts receipt
          on receipt.receive_session_id = receive.id
         and receipt.user_id = context.user_id
         and receipt.variant_id = any(consent.consented_variant_ids)
        where context.id = $1::uuid
          and receipt.status = 'ready'
          and funding_receive_receipt_matches_frozen_variant(receipt)
          and (
            (
              receipt.handling = 'direct'
              and receipt.network_id = receive.destination_asset->>'networkId'
              and receipt.asset_decimals =
                    (receive.destination_asset->>'decimals')::int
              and funding_account_identifier_equal(
                    receipt.network_id,
                    receipt.asset_id,
                    receive.destination_asset->>'assetId'
                  )
              and receipt.network_id = consent.selected_asset_network_id
              and receipt.asset_decimals = consent.selected_asset_decimals
              and funding_account_identifier_equal(
                    receipt.network_id,
                    receipt.asset_id,
                    consent.selected_asset_id
                  )
            )
            or (
              receipt.handling = 'automatic_conversion'
              and consent.automation_enabled
              and consent.max_auto_execute_source_raw is null
              and consent.automation_policy_snapshot ->> 'version' = '2'
              and consent.automation_policy_snapshot ->> 'kind' =
                    'polymarket_usdce_full_receipt_wrap'
              and consent.automation_policy_snapshot ->> 'fullReceipt' = 'true'
              and consent.automation_policy_snapshot ->> 'profileId' = $2
              and consent.automation_policy_snapshot ->> 'venueId' =
                    receive.venue_id
              and consent.automation_policy_snapshot ->> 'destinationOptionId' =
                    receive.destination_option_id
              and consent.automation_policy_snapshot ->> 'venueBindingOptionId' =
                    receive.venue_binding_option_id
              and receipt.network_id =
                    consent.automation_policy_snapshot #>> '{sourceAsset,networkId}'
              and receipt.asset_decimals::text =
                    consent.automation_policy_snapshot #>> '{sourceAsset,decimals}'
              and funding_account_identifier_equal(
                    receipt.network_id,
                    receipt.asset_id,
                    consent.automation_policy_snapshot #>>
                      '{sourceAsset,assetId}'
                  )
              and receive.destination_asset->>'networkId' =
                    consent.automation_policy_snapshot #>>
                      '{destinationAsset,networkId}'
              and receive.destination_asset->>'decimals' =
                    consent.automation_policy_snapshot #>>
                      '{destinationAsset,decimals}'
              and funding_account_identifier_equal(
                    receive.destination_asset->>'networkId',
                    receive.destination_asset->>'assetId',
                    consent.automation_policy_snapshot #>>
                      '{destinationAsset,assetId}'
                  )
              and (
                (
                  consent.selected_asset_network_id = receipt.network_id
                  and consent.selected_asset_decimals = receipt.asset_decimals
                  and funding_account_identifier_equal(
                        receipt.network_id,
                        consent.selected_asset_id,
                        receipt.asset_id
                      )
                )
                or (
                  consent.selected_asset_network_id =
                        receive.destination_asset->>'networkId'
                  and consent.selected_asset_decimals =
                        (receive.destination_asset->>'decimals')::int
                  and funding_account_identifier_equal(
                        receive.destination_asset->>'networkId',
                        consent.selected_asset_id,
                        receive.destination_asset->>'assetId'
                      )
                )
              )
              and receipt.ledger_height is not null
              and exists (
                select 1
                from jsonb_array_elements(
                  case
                    when jsonb_typeof(
                      consent.automation_policy_snapshot -> 'variantCursors'
                    ) = 'array'
                      then consent.automation_policy_snapshot -> 'variantCursors'
                    else '[]'::jsonb
                  end
                ) cursor
                where cursor ->> 'variantId' = receipt.variant_id
                  and cursor ->> 'networkId' = receipt.network_id
                  and cursor ->> 'ledgerHeightExclusive' ~
                        '^(0|[1-9][0-9]*)$'
                  and receipt.ledger_height >
                        (cursor ->> 'ledgerHeightExclusive')::numeric
              )
              and exists (
                select 1
                from funding_operations operation
                join funding_operation_steps step
                  on step.operation_id = operation.id
                 and step.ordinal = 0
                where operation.id = receipt.child_funding_operation_id
                  and operation.user_id = context.user_id
                  and operation.status = 'completed'
                  and operation.progress_stage = 'terminal'
                  and operation.support_metadata ->> 'preparationKind' =
                        'polymarket_funding_router'
                  and operation.support_metadata ->> 'fundingReceiveReceiptId' =
                        receipt.id::text
                  and operation.support_metadata ->> 'fundingAuthorizationId' =
                        consent.automation_policy_snapshot ->> 'authorizationId'
                  and operation.support_metadata ->>
                        'fundingAuthorizationFingerprint' =
                        consent.automation_policy_snapshot ->>
                          'authorizationFingerprint'
                  and operation.requested_source_amount ->> 'raw' =
                        receipt.raw_amount::text
                  and operation.requested_source_amount #>>
                        '{asset,networkId}' = receipt.network_id
                  and operation.requested_source_amount #>>
                        '{asset,decimals}' = receipt.asset_decimals::text
                  and funding_account_identifier_equal(
                        receipt.network_id,
                        operation.requested_source_amount #>>
                          '{asset,assetId}',
                        receipt.asset_id
                      )
                  and operation.requested_destination_amount ->> 'raw' =
                        receipt.raw_amount::text
                  and operation.requested_destination_amount #>>
                        '{asset,networkId}' =
                        receive.destination_asset->>'networkId'
                  and operation.requested_destination_amount #>>
                        '{asset,decimals}' =
                        receive.destination_asset->>'decimals'
                  and funding_account_identifier_equal(
                        receive.destination_asset->>'networkId',
                        operation.requested_destination_amount #>>
                          '{asset,assetId}',
                        receive.destination_asset->>'assetId'
                      )
                  and step.executor_id = $2
                  and step.state = 'succeeded'
                  and not exists (
                    select 1
                    from funding_operation_steps other_step
                    where other_step.operation_id = operation.id
                      and other_step.id <> step.id
                  )
              )
            )
          )
      ) as ready
    `,
    [contextId, POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID],
  );
  return rows[0]?.ready === true;
}
