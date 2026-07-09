#!/usr/bin/env tsx

import { pool } from "./db.js";
import { createApiTradingApplicationService } from "./services/api-trading-service.js";
import { reconcileTelegramVenueIntents } from "./services/telegram-bot-trading-venue-reconcile.js";

const EXECUTE_CONFIRMATION = "EXECUTE TELEGRAM TRADE RECONCILE";

type Options = {
  confirm: string | null;
  execute: boolean;
  intentId: string | null;
  limit: number;
  telegramUserId: string | null;
  txSignature: string | null;
  venueOrderId: string | null;
};

function parseArgs(args = process.argv.slice(2)): Options {
  const value = (flag: string): string | null => {
    const index = args.indexOf(flag);
    const candidate = index >= 0 ? args[index + 1] : null;
    return candidate && !candidate.startsWith("--") ? candidate.trim() : null;
  };
  const limitRaw = Number(value("--limit") ?? 10);
  return {
    confirm: value("--confirm"),
    execute: args.includes("--execute"),
    intentId: value("--intent-id"),
    limit: Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 25)
      : 10,
    telegramUserId: value("--telegram-user-id"),
    txSignature: value("--tx-signature"),
    venueOrderId: value("--venue-order-id"),
  };
}

async function attachVerifiedReference(options: Options): Promise<void> {
  const hasReference = Boolean(options.txSignature || options.venueOrderId);
  if (!hasReference) return;
  if (!options.intentId) {
    throw new Error("--intent-id is required when attaching a venue reference");
  }
  if (!options.execute || options.confirm !== EXECUTE_CONFIRMATION) {
    throw new Error(
      `Attaching a verified reference requires --execute --confirm "${EXECUTE_CONFIRMATION}"`,
    );
  }
  const result = await pool.query(
    `UPDATE telegram_trade_intents
        SET venue_order_id = coalesce($2, venue_order_id),
            tx_signature = coalesce($3, tx_signature),
            result = coalesce(result, '{}'::jsonb) || $4::jsonb,
            updated_at = now()
      WHERE id = $1
        AND status = ANY($5::text[])
      RETURNING id`,
    [
      options.intentId,
      options.venueOrderId,
      options.txSignature,
      JSON.stringify({
        operatorRecovery: {
          attachedAt: new Date().toISOString(),
          txSignature: options.txSignature,
          venueOrderId: options.venueOrderId,
        },
      }),
      ["executing", "reconcile_required", "submitted"],
    ],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("Intent was not found or is not recoverable");
  }
}

export async function runTelegramTradeIntentReconcileCli(
  options = parseArgs(),
): Promise<void> {
  if (options.execute && options.confirm !== EXECUTE_CONFIRMATION) {
    throw new Error(
      `Live reconciliation requires --confirm "${EXECUTE_CONFIRMATION}"`,
    );
  }
  await attachVerifiedReference(options);
  const trading = createApiTradingApplicationService({ pool });
  const summary = await reconcileTelegramVenueIntents(pool, trading, {
    dryRun: !options.execute,
    intentId: options.intentId,
    limit: options.limit,
    telegramUserId: options.telegramUserId,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTelegramTradeIntentReconcileCli()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
