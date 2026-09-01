import type { DbQuery } from "../../db.js";
import { SOLANA_MAINNET_CAIP2 } from "../../lib/chain-identifiers.js";
import { insertNotification } from "../../repos/notifications-repo.js";
import { SOLANA_NATIVE_ASSET } from "../domain/network-fees.js";
import type { FundingReceiveSessionChannel } from "../domain/types.js";
import { sameAsset } from "../planner/money.js";
import type { DirectIngressObservationVariant } from "../reconciliation/direct-ingress-observer.js";
import type { FundingReceiveCanonicalEvent } from "./canonical-receive-event-scanner.js";

export type CanonicalReceiveDepositNotificationResult =
  | "created"
  | "deduplicated"
  | "ineligible"
  | "suppressed";

export function nativeSolDepositNotificationDedupeKey(input: {
  networkId: string;
  walletAddress: string;
  amountRaw: string;
  txHash: string;
}): string | null {
  const networkId = input.networkId.trim().toLowerCase();
  const walletAddress = input.walletAddress.trim();
  const amountRaw = input.amountRaw.trim();
  const txHash = input.txHash.trim();
  if (
    networkId !== SOLANA_NATIVE_ASSET.networkId ||
    !walletAddress ||
    !/^[0-9]+$/.test(amountRaw) ||
    !txHash
  ) {
    return null;
  }
  return ["deposit", "solana-native", txHash, walletAddress, amountRaw].join(
    ":",
  );
}

function formatSolAmount(raw: string): string {
  const amount = BigInt(raw);
  const scale = 10n ** BigInt(SOLANA_NATIVE_ASSET.decimals);
  const whole = amount / scale;
  const fractional = (amount % scale)
    .toString()
    .padStart(SOLANA_NATIVE_ASSET.decimals, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

async function telegramBuyLifecycleOwnsDepositNotification(
  db: DbQuery,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
    variant: DirectIngressObservationVariant;
    now: Date;
  }>,
): Promise<boolean> {
  const { rows } = await db.query<{ suppressed: boolean }>(
    `
      select exists (
        select 1
        from telegram_funding_sessions funding_context
        join telegram_funding_buy_return_revisions buy_return
          on buy_return.telegram_funding_session_id = funding_context.id
         and buy_return.revision = funding_context.active_buy_return_revision
         and buy_return.continuation_mode = 'app_handoff'
        join telegram_funding_consents funding_consent
          on funding_consent.telegram_funding_session_id = funding_context.id
         and funding_consent.revision = funding_context.active_consent_revision
         and funding_consent.selected_asset_network_id = $3::text
         and funding_consent.selected_asset_id = $4::text
         and funding_consent.selected_asset_decimals = $5::integer
         and $6::text = any(funding_consent.consented_variant_ids)
        where funding_context.receive_session_id = $1::uuid
          and funding_context.user_id = $2::uuid
          and funding_context.origin = 'buy_return_context'
          and funding_context.active_buy_return_revision is not null
          and funding_context.cancelled_at is null
          and funding_context.expires_at > $7::timestamptz
      ) as suppressed
    `,
    [
      input.receiveSessionId,
      input.userId,
      input.variant.asset.networkId,
      input.variant.asset.assetId,
      input.variant.asset.decimals,
      input.variant.variantId,
      input.now,
    ],
  );
  return rows[0]?.suppressed === true;
}

/**
 * Native SOL is observed by Hunch's canonical scanner even when Privy does not
 * emit wallet.funds_deposited. Persist the Activity notification alongside the
 * canonical receipt, while leaving an app-handoff Buy lifecycle as the sole
 * user-visible owner of that same progress update.
 */
export async function recordCanonicalReceiveDepositNotification(
  db: DbQuery,
  input: Readonly<{
    receiveSessionId: string;
    userId: string;
    ownerChannel: FundingReceiveSessionChannel;
    variant: DirectIngressObservationVariant;
    event: FundingReceiveCanonicalEvent;
    canonicalEventId: string;
    now: Date;
  }>,
): Promise<CanonicalReceiveDepositNotificationResult> {
  if (
    input.variant.completion.kind !== "retained_owned_source_credit" ||
    !sameAsset(input.variant.asset, SOLANA_NATIVE_ASSET)
  ) {
    return "ineligible";
  }
  if (
    input.ownerChannel === "telegram" &&
    (await telegramBuyLifecycleOwnsDepositNotification(db, input))
  ) {
    return "suppressed";
  }

  const dedupeKey = nativeSolDepositNotificationDedupeKey({
    networkId: input.variant.networkId,
    walletAddress: input.event.destinationAddress,
    amountRaw: input.event.rawAmount,
    txHash: input.event.transactionHash,
  });
  if (!dedupeKey) return "ineligible";

  const amountLabel = `${formatSolAmount(input.event.rawAmount)} SOL`;
  const inserted = await insertNotification(db, {
    userId: input.userId,
    type: "deposit_received",
    title: "Deposit received",
    body: `${amountLabel} deposit received on Solana`,
    severity: "success",
    dedupeKey,
    data: {
      category: "funds",
      source: "funding_receive",
      walletAddress: input.event.destinationAddress,
      walletType: "solana",
      caip2: SOLANA_MAINNET_CAIP2,
      network: "solana",
      asset: { type: "native-token" },
      amountRaw: input.event.rawAmount,
      amountLabel,
      amountUsd: null,
      txHash: input.event.transactionHash,
      canonicalEventId: input.canonicalEventId,
      eventIndex: input.event.eventIndex,
      receiveSessionId: input.receiveSessionId,
    },
  });
  return inserted ? "created" : "deduplicated";
}
