#!/usr/bin/env tsx

/**
 * Cleanup Expired Markets Service
 *
 * This script identifies and cleans up expired markets from the database.
 * It finds markets that have passed their expiration_time or close_time
 * and either updates their status to 'CLOSED' or deletes them entirely.
 *
 * Usage:
 *   npm run cleanup:expired
 *   npm run cleanup:expired -- --dry-run
 *   npm run cleanup:expired -- --delete
 */

import { Pool } from "pg";
import { env } from "./env.js";

interface CleanupOptions {
  dryRun: boolean;
  deleteMode: boolean;
  confirmDelete: boolean;
  deleteOrphanedEvents: boolean;
}

interface ExpiredMarket {
  id: string;
  venue: string;
  venue_market_id: string;
  event_id: string;
  title: string;
  expiration_time: Date | null;
  close_time: Date | null;
  status: string;
}

interface CleanupStats {
  expiredMarkets: number;
  updatedMarkets: number;
  deletedMarkets: number;
  orphanedEvents: number;
  deletedEvents: number;
}

async function getExpiredMarkets(pool: Pool): Promise<ExpiredMarket[]> {
  const query = `
    SELECT 
      id,
      venue,
      venue_market_id,
      event_id,
      title,
      expiration_time,
      close_time,
      status
    FROM unified_markets
    WHERE status = 'ACTIVE'
      AND (
        (expiration_time IS NOT NULL AND expiration_time < now()) OR
        (close_time IS NOT NULL AND close_time < now())
      )
    ORDER BY 
      COALESCE(expiration_time, close_time) ASC
  `;

  const { rows } = await pool.query(query);
  return rows;
}

async function getOrphanedEvents(
  pool: Pool,
  eventIds: string[],
): Promise<string[]> {
  if (eventIds.length === 0) return [];

  const query = `
    SELECT e.id
    FROM unified_events e
    LEFT JOIN unified_markets m ON m.event_id = e.id AND m.status = 'ACTIVE'
    WHERE e.id = ANY($1::text[])
      AND m.id IS NULL
  `;

  const { rows } = await pool.query(query, [eventIds]);
  return rows.map((row) => row.id);
}

async function cleanupExpiredMarkets(
  pool: Pool,
  options: CleanupOptions,
): Promise<CleanupStats> {
  if (options.deleteMode && !options.confirmDelete) {
    throw new Error(
      "Delete mode requires --confirm-delete to prevent accidental destructive runs",
    );
  }

  console.log("🔍 Scanning for expired markets...");

  const expiredMarkets = await getExpiredMarkets(pool);
  console.log(`Found ${expiredMarkets.length} expired markets`);

  if (expiredMarkets.length === 0) {
    console.log("✅ No expired markets found");
    return {
      expiredMarkets: 0,
      updatedMarkets: 0,
      deletedMarkets: 0,
      orphanedEvents: 0,
      deletedEvents: 0,
    };
  }

  // Group by event for orphaned event detection
  const eventIds = [...new Set(expiredMarkets.map((m) => m.event_id))];
  const orphanedEvents = await getOrphanedEvents(pool, eventIds);

  console.log(`\n📊 Cleanup Summary:`);
  console.log(`- Expired markets: ${expiredMarkets.length}`);
  console.log(`- Affected events: ${eventIds.length}`);
  console.log(`- Orphaned events: ${orphanedEvents.length}`);

  if (options.dryRun) {
    console.log("\n🔍 DRY RUN - No changes will be made");
    console.log("\nExpired markets that would be processed:");
    expiredMarkets.forEach((market, index) => {
      const expiryTime = market.expiration_time || market.close_time;
      console.log(
        `${index + 1}. ${market.title} (${market.venue}) - Expired: ${expiryTime}`,
      );
    });

    if (options.deleteOrphanedEvents && orphanedEvents.length > 0) {
      console.log("\nOrphaned events that would be deleted:");
      orphanedEvents.forEach((eventId, index) => {
        console.log(`${index + 1}. ${eventId}`);
      });
    } else if (orphanedEvents.length > 0) {
      console.log(
        "\nOrphaned events found, but deletion is disabled (use --delete-orphaned-events to enable).",
      );
    }

    return {
      expiredMarkets: expiredMarkets.length,
      updatedMarkets: 0,
      deletedMarkets: 0,
      orphanedEvents: orphanedEvents.length,
      deletedEvents: 0,
    };
  }

  let updatedMarkets = 0;
  let deletedMarkets = 0;

  // Process expired markets
  console.log("\n🔄 Processing expired markets...");

  for (const market of expiredMarkets) {
    try {
      if (options.deleteMode) {
        // Delete the market
        await pool.query("DELETE FROM unified_markets WHERE id = $1", [
          market.id,
        ]);
        deletedMarkets++;
        console.log(`🗑️  Deleted market: ${market.title} (${market.venue})`);
      } else {
        // Update status to CLOSED
        await pool.query(
          "UPDATE unified_markets SET status = $1, updated_at_db = now() WHERE id = $2",
          ["CLOSED", market.id],
        );
        updatedMarkets++;
        console.log(
          `📝 Updated market: ${market.title} (${market.venue}) -> CLOSED`,
        );
      }
    } catch (error) {
      console.error(`❌ Error processing market ${market.id}:`, error);
    }
  }

  // Clean up orphaned events
  let deletedEvents = 0;
  if (options.deleteOrphanedEvents && orphanedEvents.length > 0) {
    console.log("\n🧹 Cleaning up orphaned events...");

    for (const eventId of orphanedEvents) {
      try {
        await pool.query("DELETE FROM unified_events WHERE id = $1", [eventId]);
        deletedEvents++;
        console.log(`🗑️  Deleted orphaned event: ${eventId}`);
      } catch (error) {
        console.error(`❌ Error deleting event ${eventId}:`, error);
      }
    }
  }

  if (!options.deleteOrphanedEvents && orphanedEvents.length > 0) {
    console.log(
      `\nℹ️  Skipped deleting ${orphanedEvents.length} orphaned events (enable with --delete-orphaned-events).`,
    );
  }

  console.log("\n✅ Cleanup completed!");

  return {
    expiredMarkets: expiredMarkets.length,
    updatedMarkets,
    deletedMarkets,
    orphanedEvents: orphanedEvents.length,
    deletedEvents,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options: CleanupOptions = {
    dryRun: args.includes("--dry-run"),
    deleteMode: args.includes("--delete"),
    confirmDelete: args.includes("--confirm-delete"),
    deleteOrphanedEvents: args.includes("--delete-orphaned-events"),
  };

  console.log("🧹 Expired Markets Cleanup Service");
  console.log("==================================");

  if (options.dryRun) {
    console.log("Mode: DRY RUN (no changes will be made)");
  } else if (options.deleteMode) {
    console.log("Mode: DELETE (markets will be permanently deleted)");
    if (!options.confirmDelete) {
      console.log(
        "⚠️  Missing --confirm-delete (required). Aborting before any destructive action.",
      );
      process.exit(1);
    }
  } else {
    console.log("Mode: UPDATE (markets will be marked as CLOSED)");
  }
  console.log(
    `Delete orphaned events: ${options.deleteOrphanedEvents ? "enabled" : "disabled"}`,
  );

  const pool = new Pool({ connectionString: env.dbUrl });

  try {
    const stats = await cleanupExpiredMarkets(pool, options);

    console.log("\n📈 Final Statistics:");
    console.log(`- Expired markets found: ${stats.expiredMarkets}`);
    console.log(`- Markets updated: ${stats.updatedMarkets}`);
    console.log(`- Markets deleted: ${stats.deletedMarkets}`);
    console.log(`- Orphaned events found: ${stats.orphanedEvents}`);
    console.log(`- Events deleted: ${stats.deletedEvents}`);
  } catch (error) {
    console.error("❌ Cleanup failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Cleanup interrupted by user");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Cleanup terminated");
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}
