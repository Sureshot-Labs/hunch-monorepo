import type { DbQuery } from "../../db.js";
import { insertNotification } from "../../repos/notifications-repo.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";
import { parseMoneyJson } from "../domain/money-json.js";
import { sameAsset } from "../domain/asset-identity.js";
import type {
  FundingObservationRow,
  FundingOperationRow,
} from "../persistence/funding-operation-repository.js";

/** Output only: never settlement evidence. Written atomically with completion,
 * so worker retries cannot lose or duplicate the Activity notification.
 */
export async function recordWithdrawalCompletionNotification(
  db: DbQuery,
  operation: FundingOperationRow,
  observations: readonly FundingObservationRow[],
): Promise<void> {
  if (operation.purpose !== "withdrawal") return;
  const amount = parseMoneyJson(operation.actualDestinationAmount);
  if (!amount) return;
  const credit = observations.find(
    (observation) =>
      observation.kind === "destination_credit" &&
      observation.canonical &&
      observation.finalityStatus === "finalized" &&
      sameAsset(amount.asset, {
        networkId: observation.networkId,
        assetId: observation.assetId,
        decimals: observation.assetDecimals,
      }),
  );
  if (!credit) return;
  const id = credit.assetId.toLowerCase();
  const symbol =
    credit.networkId === "solana:mainnet" &&
    credit.assetId === RELAY_PINNED_ASSETS.solanaNative
      ? "SOL"
      : id === RELAY_PINNED_ASSETS.polygonPusd.toLowerCase()
        ? "pUSD"
        : id === RELAY_PINNED_ASSETS.polygonUsdce.toLowerCase()
          ? "USDC.e"
          : "USDC";
  const digits = amount.raw.padStart(credit.assetDecimals + 1, "0");
  const formattedAmount =
    credit.assetDecimals === 0
      ? digits
      : `${digits.slice(0, -credit.assetDecimals)}.${digits.slice(-credit.assetDecimals)}`.replace(
          /\.?0+$/,
          "",
        );
  await insertNotification(db, {
    userId: operation.userId,
    type: "withdrawal_completed",
    title: "Withdrawal complete",
    body: `${formattedAmount} ${symbol} sent to ${credit.toAddress}`,
    severity: "success",
    dedupeKey: `withdrawal:${operation.id}`,
    data: {
      category: "funds",
      source: "funding_reconciliation",
      operationId: operation.id,
      txHash: credit.txHash,
      networkId: credit.networkId,
      assetId: credit.assetId,
      amountRaw: amount.raw,
      amountLabel: `${formattedAmount} ${symbol}`,
      recipientAddress: credit.toAddress,
    },
  });
}
