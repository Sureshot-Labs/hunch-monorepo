#!/usr/bin/env tsx

/**
 * Delete Closed Markets Service
 *
 * This script deletes all closed markets (CLOSED, SETTLED, ARCHIVED) from the database.
 * It also cleans up orphaned events that have no remaining active markets.
 *
 * Usage:
 *   npm run delete-closed
 *   npm run delete-closed -- --dry-run
 */

import { Pool } from "pg";
import { env } from "./env.js";

interface DeleteOptions {
  dryRun: boolean;
  confirmDelete: boolean;
  deleteOrphanedEvents: boolean;
}

interface ClosedMarket {
  id: string;
  venue: string;
  venue_market_id: string;
  event_id: string;
  title: string;
  status: string;
}

interface DeleteStats {
  closedMarkets: number;
  deletedMarkets: number;
  orphanedEvents: number;
  deletedEvents: number;
  venueCounts: Record<string, number>;
}

async function getClosedMarkets(pool: Pool): Promise<ClosedMarket[]> {
  const query = `
    SELECT 
      id,
      venue,
      venue_market_id,
      event_id,
      title,
      status
    FROM unified_markets
    WHERE status IN ('CLOSED', 'SETTLED', 'ARCHIVED')
    ORDER BY 
      venue, venue_market_id
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

async function deleteClosedMarkets(
  pool: Pool,
  options: DeleteOptions,
): Promise<DeleteStats> {
  if (!options.dryRun && !options.confirmDelete) {
    throw new Error(
      "Destructive delete requires --confirm-delete to prevent accidental data loss",
    );
  }

  console.log("🔍 Scanning for closed markets...");

  const closedMarkets = await getClosedMarkets(pool);
  console.log(`Found ${closedMarkets.length} closed markets`);

  if (closedMarkets.length === 0) {
    console.log("✅ No closed markets found");
    return {
      closedMarkets: 0,
      deletedMarkets: 0,
      orphanedEvents: 0,
      deletedEvents: 0,
      venueCounts: {},
    };
  }

  // Group by status for reporting
  const statusCounts = closedMarkets.reduce(
    (acc, m) => {
      acc[m.status] = (acc[m.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Group by venue for reporting
  const venueCounts = closedMarkets.reduce(
    (acc, m) => {
      acc[m.venue] = (acc[m.venue] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Group by event for orphaned event detection
  const eventIds = [...new Set(closedMarkets.map((m) => m.event_id))];
  const orphanedEvents = await getOrphanedEvents(pool, eventIds);

  console.log(`\n📊 Deletion Summary:`);
  console.log(`- Total closed markets: ${closedMarkets.length}`);
  console.log(`\n  By Venue:`);
  Object.entries(venueCounts).forEach(([venue, count]) => {
    console.log(`    - ${venue}: ${count}`);
  });
  console.log(`\n  By Status:`);
  Object.entries(statusCounts).forEach(([status, count]) => {
    console.log(`    - ${status}: ${count}`);
  });
  console.log(`\n- Affected events: ${eventIds.length}`);
  console.log(`- Orphaned events: ${orphanedEvents.length}`);

  if (options.dryRun) {
    console.log("\n🔍 DRY RUN - No changes will be made");
    console.log("\nClosed markets that would be deleted:");
    closedMarkets.slice(0, 20).forEach((market, index) => {
      console.log(
        `${index + 1}. ${market.title} (${market.venue}) - Status: ${market.status}`,
      );
    });
    if (closedMarkets.length > 20) {
      console.log(`... and ${closedMarkets.length - 20} more`);
    }

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
      closedMarkets: closedMarkets.length,
      deletedMarkets: 0,
      orphanedEvents: orphanedEvents.length,
      deletedEvents: 0,
      venueCounts,
    };
  }

  let deletedMarkets = 0;

  // Process closed markets - delete them
  console.log("\n🔄 Deleting closed markets...");

  for (const market of closedMarkets) {
    try {
      await pool.query("DELETE FROM unified_markets WHERE id = $1", [
        market.id,
      ]);
      deletedMarkets++;
      if (deletedMarkets % 100 === 0) {
        console.log(
          `  Deleted ${deletedMarkets}/${closedMarkets.length} markets...`,
        );
      }
    } catch (error) {
      console.error(`❌ Error deleting market ${market.id}:`, error);
    }
  }

  console.log(`✅ Deleted ${deletedMarkets} closed markets`);

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

  console.log("\n✅ Deletion completed!");

  return {
    closedMarkets: closedMarkets.length,
    deletedMarkets,
    orphanedEvents: orphanedEvents.length,
    deletedEvents,
    venueCounts,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options: DeleteOptions = {
    dryRun: args.includes("--dry-run"),
    confirmDelete: args.includes("--confirm-delete"),
    deleteOrphanedEvents: args.includes("--delete-orphaned-events"),
  };

  console.log("🗑️  Delete Closed Markets Service");
  console.log("==================================");

  if (options.dryRun) {
    console.log("Mode: DRY RUN (no changes will be made)");
  } else {
    console.log("Mode: DELETE (markets will be permanently deleted)");
    console.log(
      "⚠️  WARNING: This will permanently delete all closed markets!",
    );
    if (!options.confirmDelete) {
      console.log(
        "⚠️  Missing --confirm-delete (required). Aborting before any destructive action.",
      );
      process.exit(1);
    }
  }
  console.log(
    `Delete orphaned events: ${options.deleteOrphanedEvents ? "enabled" : "disabled"}`,
  );

  const pool = new Pool({ connectionString: env.dbUrl });

  try {
    const stats = await deleteClosedMarkets(pool, options);

    console.log("\n📈 Final Statistics:");
    console.log(`- Closed markets found: ${stats.closedMarkets}`);
    console.log(`- Markets deleted: ${stats.deletedMarkets}`);
    console.log(`\n  By Venue:`);
    Object.entries(stats.venueCounts).forEach(([venue, count]) => {
      console.log(`    - ${venue}: ${count}`);
    });
    console.log(`\n- Orphaned events found: ${stats.orphanedEvents}`);
    console.log(`- Events deleted: ${stats.deletedEvents}`);
  } catch (error) {
    console.error("❌ Deletion failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Deletion interrupted by user");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Deletion terminated");
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}
