// Shared exact executor predicate. Aliases are fixed internal SQL, never user input.
export const telegramReceiveConsentWhereSql = `consent.telegram_funding_session_id = telegram_context.id
          and consent.consented_at <= canonical_event.first_observed_at
          and jsonb_typeof(
                consent.automation_policy_snapshot -> 'presentation'
              ) = 'object'
          and receipt.variant_id = any(consent.consented_variant_ids)
          and (
            receipt.handling = 'review_required'
            or (
              consent.automation_enabled
              and (
                (
                  consent.max_auto_execute_source_raw is null
                  and consent.automation_policy_snapshot ->> 'version' = '2'
                  and consent.automation_policy_snapshot ->> 'fullReceipt' = 'true'
                )
                or (
                  consent.max_auto_execute_source_raw > 0
                  and consent.automation_policy_snapshot ->> 'version' = '3'
                  and consent.automation_policy_snapshot ->> 'fullReceipt' = 'false'
                  and receipt.raw_amount <= consent.max_auto_execute_source_raw
                )
              )
              and receipt.ledger_height is not null
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
                ) receive_cursor
                where receive_cursor ->> 'variantId' = receipt.variant_id
                  and receive_cursor ->> 'networkId' = receipt.network_id
                  and receive_cursor ->> 'ledgerHeightExclusive' ~ '^(0|[1-9][0-9]*)$'
                  and receipt.ledger_height >
                        (receive_cursor ->> 'ledgerHeightExclusive')::numeric
              )
            )
          )`;
