import { pool } from "./db.js";
import {
  canRepairTelegramSignalDelivery,
  executeTelegramSignalDeliveryRepair,
  inspectTelegramSignalDeliveryRepair,
} from "./services/telegram-notification-delivery.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): {
  execute: boolean;
  selector: { kind: "note" | "outbox"; id: string };
} | null {
  if (argv.includes("--help")) return null;
  const noteIndex = argv.indexOf("--note-id");
  const outboxIndex = argv.indexOf("--outbox-id");
  if (noteIndex >= 0 === outboxIndex >= 0) {
    throw new Error("Provide exactly one of --note-id or --outbox-id.");
  }
  const index = noteIndex >= 0 ? noteIndex : outboxIndex;
  const id = argv[index + 1];
  if (!id || !UUID_PATTERN.test(id))
    throw new Error("A valid UUID is required.");
  const allowed = new Set([
    "--note-id",
    "--outbox-id",
    "--execute",
    "--dry-run",
  ]);
  for (let offset = 0; offset < argv.length; offset += 1) {
    if (offset === index + 1) continue;
    if (!allowed.has(argv[offset] ?? "")) {
      throw new Error(`Unknown argument: ${argv[offset] ?? ""}`);
    }
  }
  if (argv.includes("--execute") && argv.includes("--dry-run")) {
    throw new Error("Choose --execute or --dry-run, not both.");
  }
  return {
    execute: argv.includes("--execute"),
    selector: { kind: noteIndex >= 0 ? "note" : "outbox", id },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(
      "Usage: telegram:notification:repair --note-id UUID|--outbox-id UUID [--dry-run|--execute]\n" +
        "Dry-run is the default. Only proven pre-send dead/skipped signal rows can be retried.",
    );
    return;
  }
  const rows = await inspectTelegramSignalDeliveryRepair({
    db: pool,
    selector: args.selector,
  });
  const eligible = rows.filter(canRepairTelegramSignalDelivery);
  console.log(
    JSON.stringify({
      selector: args.selector,
      mode: args.execute ? "execute" : "dry_run",
      matched: rows.length,
      eligible: eligible.length,
      rows: rows.slice(0, 100).map((row) => ({
        id: row.id,
        noteId: row.note_id,
        topic: row.topic,
        status: row.status,
        phase: row.phase,
        attempts: row.attempt_count,
        reason: row.last_error?.slice(0, 180) ?? null,
        repairable: canRepairTelegramSignalDelivery(row),
      })),
      omittedRows: Math.max(0, rows.length - 100),
    }),
  );
  if (!args.execute || eligible.length === 0) return;
  const repaired = await executeTelegramSignalDeliveryRepair({
    db: pool,
    ids: eligible.map((row) => row.id),
  });
  console.log(
    JSON.stringify({ repaired, racedOrChanged: eligible.length - repaired }),
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      `[telegram:notification:repair] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
